import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { mock } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { isEncryptedEnvelopeV2, JsonProtector } from "../../packages/database/src/encrypted-json.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

const [rootArgument, phase, directory] = process.argv.slice(2);
assert.ok(rootArgument && directory && phase);
assert.ok(["seed", "normal", "interrupt", "late", "inspect"].includes(phase));
assert.ok(["seed", "baseline", "interrupted", "completed"].includes(directory));
const root = resolve(rootArgument);
assert.match(basename(root), /^blogbot-migration-crash-[A-Za-z0-9]+$/u);
assert.equal(dirname(root).toLowerCase(),
  resolve(process.env.BLOGBOT_MIGRATION_TEST_PARENT_TMP ?? "invalid").toLowerCase());
assert.equal(resolve(process.env.LOCALAPPDATA ?? "invalid").toLowerCase(), root.toLowerCase());
assert.equal((await lstat(root)).isSymbolicLink(), false);
assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase());
assert.equal(process.env.BLOGBOT_DATA_KEY_HEX, "77".repeat(32));
const dataDir = join(root, directory);
try {
  assert.equal((await lstat(dataDir)).isSymbolicLink(), false);
} catch (error) {
  if (phase !== "seed" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const protector = new JsonProtector(Buffer.from("77".repeat(32), "hex"));

function pauseForOwnedKill(): never {
  const marker = join(root, directory + ".barrier.json");
  // Publish a complete metadata-only marker before blocking the actual process.
  // The parent kills only this child and confirms its terminal event.
  writeFileSync(marker + ".pending", JSON.stringify({ barrier: "owned-migration-child" }), { flag: "wx" });
  renameSync(marker + ".pending", marker);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("MIGRATION_BARRIER_UNEXPECTEDLY_RELEASED");
}

if (phase === "interrupt") {
  const originalWrite = process.stderr.write;
  let armed = true;
  mock.method(process.stderr, "write", (...args: unknown[]) => {
    const result = Reflect.apply(originalWrite, process.stderr, args) as boolean;
    if (armed && typeof args[0] === "string"
      && args[0].startsWith("[Blogbot] LOCAL_MIGRATION_PROGRESS blogbot_revisions ")) {
      armed = false;
      // This signal is emitted by the real migration after the page transaction
      // commits. No repository method, transaction, row or checkpoint is mocked.
      pauseForOwnedKill();
    }
    return result;
  });
}

let result: unknown;
if (phase === "inspect") {
  // Opening the raw database must not run application migrations before we
  // inspect the durable partial state left by the killed process.
  const database = new PGlite(dataDir);
  try {
    await database.waitReady;
    result = await snapshot(database);
  } finally {
    await database.close();
  }
} else {
  const repository = await PGliteBackendRepository.open(dataDir);
  try {
    if (phase === "seed") {
      await repository.getDatabase().transaction(async (transaction) => {
        await transaction.query("DELETE FROM blogbot_encryption_migrations WHERE scope = 'backend'");
        for (let index = 0; index < 401; index += 1) {
          const id = "legacy-" + String(index).padStart(6, "0");
          const revision = {
            id, translationKey: "tk-" + id, state: "APPROVED",
            tr: { title: "Sentetik " + id, slug: id, description: "Aciklama", bodyMarkdown: "Govde " + id, heroImageAlt: "Gorsel" },
            en: { title: "Synthetic " + id, slug: id, description: "Description", bodyMarkdown: "Body " + id, heroImageAlt: "Image" },
            section: "haberler", articleType: "news", author: "Fixture",
            tags: [], claims: [], sources: [], media: [],
            scheduledAt: "2026-07-30T09:00:00.000Z", adapterVersion: "1"
          };
          await transaction.query("INSERT INTO blogbot_revisions (id, value) VALUES ($1, $2::jsonb)",
            [id, JSON.stringify(revision)]);
        }
      });
    }
    result = await snapshot(repository.getDatabase());
  } finally {
    await repository.close();
  }
  if (phase === "late") pauseForOwnedKill();
}
process.stdout.write(JSON.stringify(result) + "\n");

async function snapshot(database: PGlite) {
  const rows = await database.query<{ id: string; value: unknown }>(
    "SELECT id, value FROM blogbot_revisions ORDER BY id");
  const plaintext = rows.rows.map((row) => ({
    id: row.id,
    value: isEncryptedEnvelopeV2(row.value)
      ? protector.open(row.value, { table: "blogbot_revisions", key: row.id, field: "value" })
      : row.value
  }));
  const migration = await database.query<{ version: number }>(
    "SELECT version FROM blogbot_encryption_migrations WHERE scope = 'backend'");
  const progress = await database.query<{ table_name: string; last_key: string }>(
    "SELECT table_name, last_key FROM blogbot_encryption_migration_progress WHERE scope = 'backend' ORDER BY table_name");
  const schema = await database.query(
    "SELECT version, name, sha256 FROM blogbot_schema_migrations ORDER BY version");
  const listIndex = await database.query<{ count: number | string }>(
    "SELECT count(*) AS count FROM blogbot_revision_list_index");
  const outbox = await database.query<{ count: number | string }>("SELECT count(*) AS count FROM blogbot_outbox");
  return {
    rowCount: rows.rows.length,
    sealedCount: rows.rows.filter((row) => isEncryptedEnvelopeV2(row.value)).length,
    firstId: rows.rows[0]?.id ?? "",
    lastId: rows.rows.at(-1)?.id ?? "",
    plaintextHash: hash(plaintext),
    firstPageCipherHash: hash(rows.rows.slice(0, 200)),
    ciphertextHash: hash(rows.rows),
    schemaHash: hash(schema.rows),
    sentinel: migration.rows[0]?.version ?? null,
    progress: progress.rows,
    listIndexCount: Number(listIndex.rows[0]?.count ?? -1),
    outboxCount: Number(outbox.rows[0]?.count ?? -1)
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) =>
      JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined);
  return encoded!;
}
