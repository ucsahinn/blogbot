import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const requiredFeatures = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "memories",
  "network_proxy",
  "plugins",
  "shell_tool",
  "standalone_web_search",
  "view_image"
];

const isCapabilityProbe = args.includes("--version")
  || (args.includes("--help") && args.includes("exec"))
  || (args.includes("features") && args.includes("list"));
const capabilityDelayArgument = args.find((argument) => argument.startsWith("--capability-probe-delay-ms="));
const capabilityDelayMs = args.includes("--slow-capability-probe")
  ? 1_250
  : Number(capabilityDelayArgument?.slice("--capability-probe-delay-ms=".length) ?? 0);
if (isCapabilityProbe && Number.isSafeInteger(capabilityDelayMs) && capabilityDelayMs > 0 && capabilityDelayMs <= 15_000) {
  await new Promise((resolve) => setTimeout(resolve, capabilityDelayMs));
}
const capabilityFailureMarker = args.find((argument) => argument.startsWith("--capability-failure-marker="));
if (isCapabilityProbe && capabilityFailureMarker && existsSync(capabilityFailureMarker.slice("--capability-failure-marker=".length))) {
  process.stderr.write("transient capability probe failure\n");
  process.exit(75);
}

if (args.includes("--version")) {
  const version = args.includes("--too-old-version") ? "0.146.0" : args.includes("--unsupported-version") ? "0.147.0" : "0.148.0";
  process.stdout.write("codex-cli " + version + "\n");
  process.exit(0);
}
if (args.includes("--help") && args.includes("exec")) {
  process.stdout.write([
    "--disable <FEATURE>",
    "--strict-config",
    "--sandbox <SANDBOX_MODE>",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema <FILE>",
    "--json",
    "--output-last-message <FILE>",
    "resume"
  ].join("\n"));
  process.exit(0);
}
if (args.includes("features") && args.includes("list")) {
  process.stdout.write(requiredFeatures
    .filter((feature) => !(args.includes("--missing-shell-feature") && feature === "shell_tool"))
    .join("\n"));
  process.exit(0);
}

const captureArgument = args.find((argument) => argument.startsWith("--capture-argv="));
if (captureArgument) {
  await writeFile(captureArgument.slice("--capture-argv=".length), `${JSON.stringify(args)}\n`, "utf8");
}
if (args.includes("--close-stdout-linger")) {
  process.stdout.end();
  setTimeout(() => process.exit(0), 3_000);
  await new Promise(() => undefined);
}

const outputFlag = process.argv.findIndex(
  (argument) => argument === "--output-last-message" || argument === "-o"
);
if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
  process.stderr.write("missing final output path\n");
  process.exitCode = 2;
} else if (process.argv.includes("--exit-before-reading-stdin")) {
  // Simulates a Codex runtime that dies during startup (not installed, not
  // logged in, or crashing) before it ever drains the task prompt. The parent's
  // pending stdin write then breaks, which must not crash the engine sidecar.
  process.stdin.destroy();
  process.exit(3);
} else {
  for await (const chunk of process.stdin) {
    // Consume the untrusted task prompt exactly as the real CLI does.
    void chunk;
  }
  if (process.argv.includes("--hang")) {
    // Simulates a child process retained by a Windows .cmd launcher.
    await writeFile(
      join(process.env.CODEX_HOME ?? process.cwd(), "fake-codex-child.pid"),
      `${process.pid}\n`,
      "utf8"
    );
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  if (process.argv.includes("--heartbeat")) {
    // A real CLI can keep reporting lifecycle activity while never producing
    // its final schema-bound answer. The runner deadline must win even when
    // stdout remains active.
    setInterval(() => {
      process.stdout.write(`${JSON.stringify({ type: "turn.updated" })}\n`);
    }, 25);
    await new Promise(() => undefined);
  }
  const finalOutput = process.argv.includes("--oversized-output")
    ? { kind: "x".repeat(1_100_000) }
    : { kind: "news" };
  const output = { kind: "news" };
  if (!process.argv.includes("--ephemeral")) {
    process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "019fae00-0000-7000-8000-000000000001" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(output) }
    })}\n`
  );
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  await writeFile(
    process.argv[outputFlag + 1],
    process.argv.includes("--invalid-final-output") ? "not-json" : JSON.stringify(finalOutput),
    "utf8"
  );
}
