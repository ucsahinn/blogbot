import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const outputFlag = process.argv.findIndex(
  (argument) => argument === "--output-last-message" || argument === "-o"
);
if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
  process.stderr.write("missing final output path\n");
  process.exitCode = 2;
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
