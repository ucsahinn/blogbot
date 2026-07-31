import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileLocalPersistence } from "../../packages/database/src/local-persistence.ts";

test("JSON local persistence writes atomically and reads after a new instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-persistence-"));
  const path = join(root, "state", "checkpoint.json");
  const first = new JsonFileLocalPersistence<{ version: number }>(path);
  await first.write({ version: 1 });

  const second = new JsonFileLocalPersistence<{ version: number }>(path);
  assert.deepEqual(await second.read(), { version: 1 });
  assert.match(await readFile(path, "utf8"), /"version":1/);
});
