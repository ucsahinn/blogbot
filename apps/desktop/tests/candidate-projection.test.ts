import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native workspace preserves measured candidate ranking details for Content Flow", async () => {
  const commands = await readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const candidateProjection = commands.slice(commands.indexOf("let candidates = candidate_values"));

  assert.match(candidateProjection, /"rankingScore": candidate\.get\("rankingScore"\)/u);
  assert.match(candidateProjection, /"scoreReasons": candidate\.get\("scoreReasons"\)/u);
  assert.match(candidateProjection, /"freshnessScore": candidate\.get\("freshnessScore"\)/u);
  assert.doesNotMatch(candidateProjection, /0\.65/u, "review rows must not invent a 65% progress value");
});