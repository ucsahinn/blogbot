import { writeFile } from "node:fs/promises";
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
    JSON.stringify(finalOutput),
    "utf8"
  );
}
