import assert from "node:assert/strict";
import test from "node:test";

import type { EngineCommandV1 } from "../../packages/contracts/src/index.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import {
  InMemoryLocalEngineCheckpointStore,
  LocalEngine
} from "../../apps/engine/src/local-engine.ts";

function automationCommand(
  overrides: Partial<Extract<EngineCommandV1, { kind: "AUTOMATION.SET" }>> = {}
): Extract<EngineCommandV1, { kind: "AUTOMATION.SET" }> {
  return {
    version: 1,
    requestId: "command-automation-1",
    idempotencyKey: "automation-key-1",
    expectedVersion: 0,
    kind: "AUTOMATION.SET",
    payload: {
      settings: {
        mode: "DRAFT_ONLY",
        onboardingComplete: false,
        ingestionPaused: false,
        publishingPaused: true,
        timezone: "Europe/Istanbul",
        scanIntervalMinutes: 30
      }
    },
    ...overrides
  };
}

test("local engine applies an automation command and records a non-authoritative checkpoint", async () => {
  const checkpointStore = new InMemoryLocalEngineCheckpointStore();
  const engine = new LocalEngine({
    repository: new InMemoryBackendStore(),
    checkpoints: checkpointStore
  });

  const result = await engine.execute(automationCommand());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sequence, 1);
  assert.equal(result.kind, "AUTOMATION.SET");
  assert.deepEqual(result.value, automationCommand().payload.settings);
  assert.deepEqual(await checkpointStore.read(), {
    version: 1,
    lastRequestId: "command-automation-1",
    lastSequence: 1
  });
});

test("local engine replays a command but rejects an idempotency key with changed content", async () => {
  const engine = new LocalEngine({
    repository: new InMemoryBackendStore(),
    checkpoints: new InMemoryLocalEngineCheckpointStore()
  });
  const command = automationCommand();

  const first = await engine.execute(command);
  const replay = await engine.execute(command);
  const conflict = await engine.execute(
    automationCommand({
      requestId: "command-automation-2",
      payload: {
        settings: {
          ...command.payload.settings,
          ingestionPaused: true
        }
      }
    })
  );

  assert.deepEqual(replay, first);
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(conflict.error.retryable, false);
});

test("local engine returns a typed validation error before changing local state", async () => {
  const repository = new InMemoryBackendStore();
  const engine = new LocalEngine({
    repository,
    checkpoints: new InMemoryLocalEngineCheckpointStore()
  });

  const result = await engine.execute({
    version: 1,
    requestId: "bad-command",
    idempotencyKey: "bad-key",
    expectedVersion: 0,
    kind: "AUTOMATION.SET",
    payload: {
      settings: {
        mode: "UNSUPPORTED",
        onboardingComplete: false,
        ingestionPaused: false,
        publishingPaused: true,
        timezone: "Europe/Istanbul",
        scanIntervalMinutes: 30
      }
    }
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_COMMAND");
  assert.deepEqual((await repository.sync(0)).snapshot.automation, {
    mode: "INGEST_ONLY",
    onboardingComplete: false,
    ingestionPaused: false,
    publishingPaused: true,
    timezone: "Europe/Istanbul",
    scanIntervalMinutes: 30
  });
});

test("local engine rejects a stale expectedVersion before mutating state", async () => {
  const repository = new InMemoryBackendStore();
  const engine = new LocalEngine({
    repository,
    checkpoints: new InMemoryLocalEngineCheckpointStore()
  });

  const first = await engine.execute(automationCommand());
  assert.equal(first.ok, true);

  const stale = await engine.execute(
    automationCommand({
      requestId: "command-automation-stale",
      idempotencyKey: "automation-key-stale",
      expectedVersion: 0,
      payload: {
        settings: {
          ...automationCommand().payload.settings,
          ingestionPaused: true
        }
      }
    })
  );

  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.error.code, "VERSION_CONFLICT");
  assert.equal((await repository.sync(0)).serverCursor, 1);
});
