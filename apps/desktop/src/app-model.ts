import type {
  ArticleType,
  CandidateView,
  DraftView,
  FailureView,
  InstantCreateCommand,
  PrerequisiteCheck,
  ScheduledPublicationView,
  TodayWorkItem,
  Section,
  SetupConnectorId
} from "./types.ts";

/** Connector ids are internal; setup copy must remain site-neutral. */
export function setupConnectorLabel(connector: SetupConnectorId): string {
  switch (connector) {
    case "codex":
      return "Yazı üretimi";
    case "github":
      return "GitHub";
    case "site":
      return "Site";
    case "deploy":
      return "Yayın iş akışı";
    case "backup":
      return "Yedekleme";
  }
}

export function isRecoveryKeyUsable(value: string): boolean {
  return value.trim().length >= 16;
}

export interface SourceParseResult {
  accepted: string[];
  rejected: string[];
}

export function hasRuntimeCapability(
  capabilities: readonly string[],
  capability: string
): boolean {
  return capabilities.includes(capability);
}

const forbiddenHostnames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "host.docker.internal",
  "gateway.docker.internal"
]);

function isObviouslyPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function normalizeSourceUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    forbiddenHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    isObviouslyPrivateIpv4(hostname) ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  ) {
    return null;
  }

  parsed.hash = "";
  return parsed.toString();
}

function parseCandidates(values: string[]): SourceParseResult {
  const accepted = new Set<string>();
  const rejected = new Set<string>();

  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value.length === 0) {
      continue;
    }
    const normalized = normalizeSourceUrl(value);
    if (normalized === null) {
      rejected.add(value);
    } else {
      accepted.add(normalized);
    }
  }

  return {
    accepted: [...accepted],
    rejected: [...rejected]
  };
}

export function parseUrlSources(input: string): SourceParseResult {
  return parseCandidates(input.split(/[\s,;]+/u));
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export function parseOpmlSources(input: string): SourceParseResult {
  const candidates: string[] = [];
  const outlinePattern = /<outline\b[^>]*>/giu;
  for (const match of input.matchAll(outlinePattern)) {
    const outline = match[0];
    const url =
      /\bxmlUrl\s*=\s*["']([^"']+)["']/iu.exec(outline)?.[1] ??
      /\bhtmlUrl\s*=\s*["']([^"']+)["']/iu.exec(outline)?.[1];
    if (url) {
      candidates.push(decodeXmlAttribute(url));
    }
  }
  return parseCandidates(candidates);
}

export interface InstantCreateFormValue {
  instruction: string;
  sourceIds: string[];
  urls: string[];
  section: Section | "";
  articleType: ArticleType;
  urgency: "normal" | "urgent";
  tone: InstantCreateCommand["tone"];
  length: InstantCreateCommand["length"];
  visualPolicy: InstantCreateCommand["visualPolicy"];
  scheduleIntent: InstantCreateCommand["scheduleIntent"];
}

type InstantCreateError =
  | "INSTRUCTION_TOO_SHORT"
  | "SOURCE_EVIDENCE_REQUIRED"
  | "TARGET_SECTION_REQUIRED";

export type InstantCreateResult =
  | { valid: true; request: InstantCreateCommand }
  | {
      valid: false;
      errors: InstantCreateError[];
    };

export function buildInstantCreateRequest(
  form: InstantCreateFormValue
): InstantCreateResult {
  const errors: InstantCreateError[] = [];
  const instruction = form.instruction.trim();
  if (instruction.length < 10) {
    errors.push("INSTRUCTION_TOO_SHORT");
  }
  if (form.sourceIds.length === 0 && form.urls.length === 0) {
    errors.push("SOURCE_EVIDENCE_REQUIRED");
  }
  if (form.section.length === 0) {
    errors.push("TARGET_SECTION_REQUIRED");
  }
  if (errors.length > 0 || form.section === "") {
    return { valid: false, errors };
  }

  return {
    valid: true,
    request: {
      instruction,
      sourceIds: [...new Set(form.sourceIds)],
      urls: [...new Set(form.urls)],
      targetSection: form.section,
      articleType: form.articleType,
      urgency: form.urgency,
      tone: form.tone,
      length: form.length,
      visualPolicy: form.visualPolicy,
      scheduleIntent: form.scheduleIntent,
      requestedPublishMode: "REVIEW"
    }
  };
}

export function summarizePrerequisites(
  checks: ReadonlyArray<
    Pick<PrerequisiteCheck, "id" | "state" | "scope">
  >
): {
  appUsable: boolean;
  writeReady: boolean;
  publishReady: boolean;
  ready: number;
  total: number;
} {
  // An empty list means the Doctor request has not completed (or failed), not
  // that every scope is ready. Array.every([]) is true by definition, which
  // would otherwise briefly unlock setup actions during the initial render.
  if (checks.length === 0) {
    return {
      appUsable: false,
      writeReady: false,
      publishReady: false,
      ready: 0,
      total: 0
    };
  }
  const isReady = (scope: PrerequisiteCheck["scope"]) =>
    (() => {
      const scopedChecks = checks.filter(
        (check) => check.scope === scope && check.id !== "backup"
      );
      return scopedChecks.length > 0 && scopedChecks.every((check) => check.state === "READY");
    })();
  const appUsable = isReady("APP");
  const writeReady = appUsable && isReady("WRITE");
  return {
    appUsable,
    writeReady,
    publishReady: writeReady && isReady("PUBLISH"),
    ready: checks.filter((check) => check.state === "READY").length,
    total: checks.length
  };
}

export function canEnableAutomationMode(
  mode: "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED",
  summary: Pick<ReturnType<typeof summarizePrerequisites>, "appUsable" | "writeReady" | "publishReady">
): boolean {
  if (!summary.appUsable) return false;
  if (mode === "INGEST_ONLY") return true;
  if (mode === "DRAFT_ONLY") return summary.writeReady;
  return summary.publishReady;
}

export function summarizeWorkspace(
  workspace: {
    today: ReadonlyArray<Pick<TodayWorkItem, "state" | "priority">>;
    candidates: ReadonlyArray<Pick<CandidateView, "state">>;
    drafts: ReadonlyArray<Pick<DraftView, "state">>;
    scheduled: ReadonlyArray<Pick<ScheduledPublicationView, "state">>;
    failures: ReadonlyArray<Pick<FailureView, "state">>;
  }
): {
  openToday: number;
  activeCandidates: number;
  reviewRequired: number;
  scheduledReady: number;
  actionRequired: number;
} {
  return {
    openToday: workspace.today.filter((item) => item.state === "OPEN").length,
    activeCandidates: workspace.candidates.filter(
      (candidate) =>
        candidate.state !== "DISMISSED" && candidate.state !== "PROMOTED"
    ).length,
    reviewRequired: workspace.drafts.filter(
      (draft) => draft.state === "REVIEW_REQUIRED"
    ).length,
    scheduledReady: workspace.scheduled.filter(
      (publication) => publication.state === "READY"
    ).length,
    actionRequired: workspace.failures.filter(
      (failure) => failure.state === "ACTION_REQUIRED"
    ).length
  };
}
