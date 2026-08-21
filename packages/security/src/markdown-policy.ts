export interface MarkdownPolicyResult {
  valid: boolean;
  blockers: string[];
}

const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Removes code spans and fenced code blocks so their contents are not treated as
 * publishable markup.
 *
 * Fences are line-anchored on purpose. A regex that matched any ``` or ~~~ run
 * also matched inline occurrences, so untrusted source text could wrap raw HTML
 * or a `javascript:` link in an inline `~~~ ... ~~~` pair, disappear from every
 * check below, and still be published verbatim.
 *
 * An unterminated fence is deliberately NOT stripped: for a security scanner the
 * safe direction is to inspect too much, never too little.
 */
function stripCode(markdown: string): string {
  const lines = markdown.split("\n");
  const stripped = [...lines];
  let fence: string | undefined;
  let openedAt = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opener = FENCE_OPENER.exec(line);
    if (fence === undefined) {
      // A backtick fence's info string may not contain a backtick, so a line
      // like ``` a ` b ``` is a code span, not a fence.
      if (opener && !(opener[1]!.startsWith("`") && opener[2]!.includes("`"))) {
        fence = opener[1]!;
        openedAt = index;
        stripped[index] = "";
      }
      continue;
    }
    stripped[index] = "";
    const closes =
      opener !== null &&
      opener[1]![0] === fence[0] &&
      opener[1]!.length >= fence.length &&
      opener[2]!.trim() === "";
    if (closes) {
      fence = undefined;
      openedAt = -1;
    }
  }

  if (fence !== undefined && openedAt >= 0) {
    // Never closed: restore those lines so they are still inspected.
    for (let index = openedAt; index < lines.length; index += 1) {
      stripped[index] = lines[index]!;
    }
  }

  return stripped.join("\n").replace(/`[^`\n]*`/g, "");
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
  let decoded = decodeBasicEntities(value);
  try {
    for (;;) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    // A malformed escape cannot be canonicalized safely. The percent sentinel
    // is rejected by both link and image validation below.
    return "%invalid-percent-encoding%";
  }
  return decoded
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
  if (withoutQuery.includes("%") || withoutQuery.includes("\\")) {
    blockers.add("IMAGE_PATH_OUTSIDE_ALLOWLIST");
    return;
  }
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
    !withoutQuery.startsWith("./images/")
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

  // CommonMark shortcut references: `[label]` resolved by a matching
  // `[label]: target` definition, with no `(...)` or `[...]` suffix. These
  // render exactly like inline links, so their targets need the same checks.
  // The link-definition lines themselves are skipped; they are the definitions,
  // not uses.
  for (const match of content.matchAll(/(!?)\[([^\]\n]+)](?![([:])/g)) {
    const isImage = match[1] === "!";
    const label = match[2]!;
    const target = referenceTargets.get(normalizedReferenceLabel(label));
    if (target === undefined) {
      // An unresolved `[text]` is ordinary literal text in CommonMark, not a
      // link, so it is not a policy violation.
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
