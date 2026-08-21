import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import test from "node:test";

import {
  BackupError,
  createLogicalBackup,
  logicalRestoreTables,
  planLogicalRestore,
  LOGICAL_BACKUP_LIMITS,
  type LogicalTableDump
} from "../../packages/backup/src/index.ts";

const recoveryKey = "correct horse battery staple 2026";

function tables(): LogicalTableDump[] {
  return [
    {
      name: "blogbot_automation",
      columns: ["singleton_id", "value"],
      rows: [[1, { mode: "PUBLISH_APPROVED", onboardingComplete: true }]],
      generatedColumns: ["singleton_id"]
    },
    {
      name: "blogbot_revisions",
      columns: ["id", "value"],
      rows: [
        // Values arrive already sealed by the repository's own envelope, so the
        // archive never widens the same-profile recovery boundary.
        ["revision-1", { alg: "A256GCM", iv: "aaaa", ct: "bbbb" }],
        ["revision-2", { alg: "A256GCM", iv: "cccc", ct: "dddd" }]
      ]
    }
  ];
}

test("a logical backup round-trips every archived row", async () => {
  const archive = await createLogicalBackup({
    tables: tables(),
    recoveryKey,
    createdAt: "2026-08-19T10:00:00.000Z"
  });

  const plan = await planLogicalRestore({ archive, recoveryKey });

  assert.equal(plan.createdAt, "2026-08-19T10:00:00.000Z");
  assert.equal(plan.totalRows, 3);
  assert.deepEqual(
    plan.tables.map((table) => [table.name, table.rowCount]),
    [["blogbot_automation", 1], ["blogbot_revisions", 2]]
  );
  assert.deepEqual(logicalRestoreTables(plan), tables());
});

test("a logical backup stays small enough to actually exist for a real workspace", async () => {
  // The file backup cannot archive a live PGlite directory at all: ~1168 files,
  // ~371 MB, with one relation file of 217 MB against a 16 MiB per-file bound.
  // The rows Blogbot owns are a tiny fraction of that, which is the whole point
  // of archiving them instead.
  const rows: Array<[string, unknown]> = [];
  for (let index = 0; index < 2_000; index += 1) {
    rows.push([`revision-${index}`, { alg: "A256GCM", iv: "a".repeat(16), ct: "b".repeat(2_048) }]);
  }
  const archive = await createLogicalBackup({
    tables: [{ name: "blogbot_revisions", columns: ["id", "value"], rows }],
    recoveryKey,
    createdAt: "2026-08-19T10:00:00.000Z"
  });

  assert.ok(
    archive.byteLength < 16 * 1024 * 1024,
    `2000 sealed revisions must archive well under the old per-file bound, got ${archive.byteLength}`
  );
  const plan = await planLogicalRestore({ archive, recoveryKey });
  assert.equal(plan.totalRows, 2_000);
});

test("the wrong recovery key fails closed instead of returning rows", async () => {
  const archive = await createLogicalBackup({ tables: tables(), recoveryKey });

  await assert.rejects(
    () => planLogicalRestore({ archive, recoveryKey: "a different recovery phrase" }),
    (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "BACKUP_DECRYPT_FAILED");
      return true;
    }
  );
});

test("a tampered row is rejected by its table digest", async () => {
  // Keep the honest manifest and swap in mutated rows. Only the per-table digest
  // can catch this: the envelope's auth tag is recomputed by the attacker.
  const honest = await createLogicalBackup({
    tables: tables(),
    recoveryKey,
    createdAt: "2026-08-19T10:00:00.000Z"
  });
  const envelope = JSON.parse(honest.toString("utf8")) as {
    kdf: { salt: string; N: number; r: number; p: number; maxmem: number };
    cipher: { name: string; iv: string; tag: string };
    ciphertext: string;
  };
  const key = await scryptKey(Buffer.from(envelope.kdf.salt, "base64"), envelope.kdf);
  const payload = decryptJson(envelope, key) as { manifest: unknown; tables: LogicalTableDump[] };
  payload.tables = payload.tables.map((table) => table.name === "blogbot_revisions"
    ? { ...table, rows: [[table.rows[0]![0], { alg: "A256GCM", iv: "zzzz", ct: "evil" }], ...table.rows.slice(1)] }
    : table);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const tampered = Buffer.from(JSON.stringify({
    ...envelope,
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64")
  }), "utf8");

  await assert.rejects(
    () => planLogicalRestore({ archive: tampered, recoveryKey }),
    (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "BACKUP_FILE_INTEGRITY_INVALID");
      return true;
    }
  );
});

function scryptKey(
  salt: Buffer,
  parameters: { N: number; r: number; p: number; maxmem: number }
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(recoveryKey.normalize("NFKC"), salt, 32, parameters, (error, derived) => {
      if (error) reject(error);
      else resolvePromise(Buffer.from(derived));
    });
  });
}

function decryptJson(
  envelope: { cipher: { iv: string; tag: string }; ciphertext: string },
  key: Buffer
): unknown {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8")) as unknown;
}

test("create refuses an archive this build could never restore", async () => {
  await assert.rejects(
    () => createLogicalBackup({
      tables: [{
        name: "blogbot_revisions",
        columns: ["id"],
        rows: Array.from({ length: LOGICAL_BACKUP_LIMITS.maxRowsPerTable + 1 }, (_, index) => [`r-${index}`])
      }],
      recoveryKey
    }),
    (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "BACKUP_LIMIT_EXCEEDED");
      return true;
    }
  );
});

test("an archive cannot talk this build into a cheap key derivation", async () => {
  const archive = await createLogicalBackup({ tables: tables(), recoveryKey });
  const envelope = JSON.parse(archive.toString("utf8")) as { kdf: { N: number } };
  envelope.kdf.N = 2;

  await assert.rejects(
    () => planLogicalRestore({ archive: Buffer.from(JSON.stringify(envelope), "utf8"), recoveryKey }),
    (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "BACKUP_ARCHIVE_INVALID");
      return true;
    }
  );
});

test("restore requires the exact salt, IV, and authentication tag lengths", async (t) => {
  const archive = await createLogicalBackup({ tables: tables(), recoveryKey });
  const envelope = JSON.parse(archive.toString("utf8")) as {
    kdf: { salt: string };
    cipher: { iv: string; tag: string };
  };
  const cases = [
    { name: "15-byte salt", field: "salt", bytes: 15 },
    { name: "17-byte salt", field: "salt", bytes: 17 },
    { name: "11-byte IV", field: "iv", bytes: 11 },
    { name: "13-byte IV", field: "iv", bytes: 13 },
    { name: "15-byte authentication tag", field: "tag", bytes: 15 },
    { name: "17-byte authentication tag", field: "tag", bytes: 17 }
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const malformed = structuredClone(envelope);
      if (fixture.field === "salt") malformed.kdf.salt = Buffer.alloc(fixture.bytes, 1).toString("base64");
      else malformed.cipher[fixture.field] = Buffer.alloc(fixture.bytes, 1).toString("base64");

      await assert.rejects(
        () => planLogicalRestore({ archive: Buffer.from(JSON.stringify(malformed), "utf8"), recoveryKey }),
        (error: unknown) => {
          assert.ok(error instanceof BackupError);
          assert.equal(error.code, "BACKUP_ARCHIVE_INVALID");
          return true;
        }
      );
    });
  }
});

test("table columns must be unique bounded identifiers", async (t) => {
  const cases: Array<{ name: string; columns: string[]; row: unknown[] }> = [
    { name: "duplicate column", columns: ["id", "id"], row: [1, 1] },
    {
      name: "overlong column",
      columns: ["a".repeat(LOGICAL_BACKUP_LIMITS.maxTableNameLength + 1)],
      row: [1]
    },
    { name: "unsafe column", columns: ["unsafe-column"], row: [1] }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => createLogicalBackup({
          tables: [{ name: "blogbot_records", columns: fixture.columns, rows: [fixture.row] }],
          recoveryKey
        }),
        (error: unknown) => {
          assert.ok(error instanceof BackupError);
          assert.equal(error.code, "BACKUP_SOURCE_INVALID");
          return true;
        }
      );
    });
  }
});

test("generated columns must be unique bounded columns from their table", async (t) => {
  const cases: Array<{ name: string; generatedColumns: unknown }> = [
    { name: "non-array metadata", generatedColumns: "id" },
    { name: "duplicate generated column", generatedColumns: ["id", "id"] },
    { name: "unknown generated column", generatedColumns: ["missing"] },
    { name: "unsafe generated column", generatedColumns: ["unsafe-column"] },
    {
      name: "overlong generated column",
      generatedColumns: ["a".repeat(LOGICAL_BACKUP_LIMITS.maxTableNameLength + 1)]
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => createLogicalBackup({
          tables: [{
            name: "blogbot_records",
            columns: ["id"],
            rows: [[1]],
            generatedColumns: fixture.generatedColumns as readonly string[]
          }],
          recoveryKey
        }),
        (error: unknown) => {
          assert.ok(error instanceof BackupError);
          assert.equal(error.code, "BACKUP_SOURCE_INVALID");
          return true;
        }
      );
    });
  }
});

test("non-finite numbers anywhere in a row are rejected instead of becoming null", async (t) => {
  const cases: Array<{ name: string; value: unknown }> = [
    { name: "NaN", value: Number.NaN },
    { name: "positive infinity", value: Number.POSITIVE_INFINITY },
    { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { name: "nested non-finite number", value: { metrics: [1, Number.NaN] } }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => createLogicalBackup({
          tables: [{ name: "blogbot_records", columns: ["value"], rows: [[fixture.value]] }],
          recoveryKey
        }),
        (error: unknown) => {
          assert.ok(error instanceof BackupError);
          assert.equal(error.code, "BACKUP_SOURCE_INVALID");
          return true;
        }
      );
    });
  }
});
