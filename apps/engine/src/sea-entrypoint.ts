import { runStdioEngine } from "./stdio-entrypoint.ts";

void runStdioEngine().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "engine failure"}\n`
  );
  process.exitCode = 1;
});
