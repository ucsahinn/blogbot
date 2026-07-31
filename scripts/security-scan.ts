import {
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Finding {
  code: string;
  file: string;
  line?: number;
}

const ignoredDirectories = new Set([
  ".git",
  ".serena",
  "node_modules",
  "dist",
  "target",
  "coverage",
  "artifacts",
  "test-results",
  "playwright-report"
]);

const forbiddenNames = new Set([
  "auth.json",
  ".env",
  "id_rsa",
  "id_ed25519"
]);

const forbiddenExtensions = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12"
]);

const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OPENAI_KEY", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GITHUB_TOKEN", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS_ACCESS_KEY", /\bAKIA[A-Z0-9]{16}\b/]
];

const textExtensions = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml"
]);

function walk(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(absolute));
    } else if (entry.isFile()) {
      result.push(absolute);
    }
  }
  return result;
}

export function scanRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const absolute of walk(root)) {
    const file = relative(root, absolute).replaceAll("\\", "/");
    const name = file.split("/").at(-1)?.toLowerCase() ?? "";
    const extension = extname(name);
    if (
      forbiddenNames.has(name) ||
      forbiddenExtensions.has(extension)
    ) {
      findings.push({ code: "FORBIDDEN_SECRET_FILE", file });
      continue;
    }
    if (
      !textExtensions.has(extension) ||
      statSync(absolute).size > 2_000_000
    ) {
      continue;
    }

    const content = readFileSync(absolute, "utf8");
    const lines = content.split(/\r?\n/);
    for (const [code, pattern] of secretPatterns) {
      const lineIndex = lines.findIndex((line) => pattern.test(line));
      if (lineIndex >= 0) {
        findings.push({ code, file, line: lineIndex + 1 });
      }
    }

    if (
      file.startsWith("apps/desktop/src/") &&
      /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(content)
    ) {
      findings.push({ code: "WEBVIEW_DIRECT_NETWORK", file });
    }
  }
  return findings;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = process.cwd();
  const findings = scanRepository(root);
  if (findings.length > 0) {
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, findings: [] }));
  }
}
