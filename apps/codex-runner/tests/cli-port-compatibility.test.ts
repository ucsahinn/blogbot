import assert from "node:assert/strict";
import test from "node:test";

import { versionIsSupported } from "../src/cli-port.ts";

test("a capability-compatible Codex banner is not rejected only because its version label differs", () => {
  assert.equal(versionIsSupported("Codex CLI version 0.149.0"), true);
});