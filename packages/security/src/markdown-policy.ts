export interface MarkdownPolicyResult {
  valid: boolean;
  blockers: string[];
}

function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function decodeBasicEntities(value: string): string {
  const codePoint = (digits: string, radix: number): string => {
    const value = Number.parseInt(digits, radix);
    return Number.isInteger(value)
      && value >= 0
      && value <= 0x10ffff
      && (value < 0xd800 || value > 0xdfff)
      ? String.fromCodePoint(value)
      : "\uFFFD";
  };
  return value
    .replace(/&#x([a-f0-9]+);?/gi, (_match, digits: string) =>
      codePoint(digits, 16)
    )
    .replace(/&#([0-9]+);?/g, (_match, digits: string) =>
      codePoint(digits, 10)
    )
    .replaceAll("&colon;", ":")
    .replaceAll("&tab;", "\t")
    .replaceAll("&newline;", "\n");
}

function normalizedTarget(value: string): string {
  return decodeBasicEntities(value)
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x20 && code !== 0x7f;
    })
    .join("")
    .toLowerCase();
}

function isSafeLinkTarget(target: string): boolean {
  const normalized = normalizedTarget(target);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("#")
  ) {
    return true;
  }
  try {
    const parsed = new URL(target);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateImageTarget(target: string, blockers: Set<string>): void {
  const normalized = normalizedTarget(target);
  if (/^(?:https?:|data:|javascript:)/i.test(normalized)) {
    blockers.add("REMOTE_IMAGE_FORBIDDEN");
    return;
  }
  const withoutQuery = normalized.split(/[?#]/, 1)[0] ?? normalized;
  // The renderer only owns the image directory. Do not let a relative path
  // navigate out of it after a filesystem or URL implementation normalizes it.
  if (withoutQuery.split("/").some((part, index) => part === ".." || (part === "." && index > 0))) {
    blockers.add("IMAGE_PATH_OUTSIDE_ALLOWLIST");
    return;
  }
  if (!/\.(?:png|webp|avif)$/.test(withoutQuery)) {
    blockers.add("UNSAFE_IMAGE_FORMAT");
  }
  if (
    !withoutQuery.startsWith("/images/") &&
    !withoutQuery.startsWith("./images/") &&
    !withoutQuery.startsWith("../images/")
  ) {
    blockers.add("IMAGE_PATH_OUTSIDE_ALLOWLIST");
  }
}

function normalizedReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function validatePublishableMarkdown(markdown: string): MarkdownPolicyResult {
  const blockers = new Set<string>();
  const content = stripCode(markdown);

  if (/^\s*(?:import|export)\s.+from\s+["']/m.test(content)) {
    blockers.add("MDX_FORBIDDEN");
  }
  if (/<\/?[a-z][^>]*>/i.test(content)) {
    blockers.add("RAW_HTML_FORBIDDEN");
  }

  for (const match of content.matchAll(/(!?)\[[^\]]*]\(\s*([^\s)]+)[^)]*\)/g)) {
    const isImage = match[1] === "!";
    const target = match[2];
    if (!target) {
      blockers.add(isImage ? "UNSAFE_IMAGE_FORMAT" : "UNSAFE_LINK_TARGET");
      continue;
    }
    if (isImage) {
      validateImageTarget(target, blockers);
    } else if (!isSafeLinkTarget(target)) {
      blockers.add("UNSAFE_LINK_TARGET");
    }
  }

  const referenceTargets = new Map<string, string>();
  for (const match of content.matchAll(
    /^[ \t]{0,3}\[([^\]\n]+)]\s*:\s*(?:<([^>\n]+)>|([^\s\n]+))/gm
  )) {
    const label = match[1];
    const target = match[2] ?? match[3];
    if (label && target) {
      referenceTargets.set(normalizedReferenceLabel(label), target);
    }
  }

  for (const match of content.matchAll(
    /(!?)\[([^\]\n]*)]\[([^\]\n]*)]/g
  )) {
    const isImage = match[1] === "!";
    const label = match[3] || match[2];
    const target = label
      ? referenceTargets.get(normalizedReferenceLabel(label))
      : undefined;
    if (!target) {
      blockers.add(isImage ? "UNSAFE_IMAGE_FORMAT" : "UNSAFE_LINK_TARGET");
      continue;
    }
    if (isImage) {
      validateImageTarget(target, blockers);
    } else if (!isSafeLinkTarget(target)) {
      blockers.add("UNSAFE_LINK_TARGET");
    }
  }

  return {
    valid: blockers.size === 0,
    blockers: [...blockers]
  };
}
