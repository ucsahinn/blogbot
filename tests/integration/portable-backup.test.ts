import assert from "node:assert/strict";
import {
  createDecipheriv,
  createCipheriv,
  scrypt as scryptCallback
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BackupError,
  applyPortableRestorePlan,
  createPortableBackup,
  planPortableRestore
} from "../../packages/backup/src/index.ts";

const recoveryKey = "correct horse battery staple 2026";

test("portable backup encrypts files and restore remains preview-first", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(join(source, "evidence"), { recursive: true });
  writeFileSync(join(source, "engine.snapshot"), "PRIVATE-ENGINE-CANARY");
  writeFileSync(join(source, "evidence", "claim.json"), '{"claim":"verified"}');

  try {
    const archive = await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["engine.snapshot", "evidence/claim.json"],
      recoveryKey,
      createdAt: "2026-07-30T10:00:00.000Z"
    });

    assert.doesNotMatch(archive.toString("utf8"), /PRIVATE-ENGINE-CANARY/);
    assert.doesNotMatch(archive.toString("utf8"), /claim\.json/);

    const plan = await planPortableRestore({
      archive,
      recoveryKey,
      targetDirectory: target
    });

    assert.equal(existsSync(target), false, "preview must not write");
    assert.equal(plan.version, 1);
    assert.equal(plan.createdAt, "2026-07-30T10:00:00.000Z");
    assert.deepEqual(
      plan.entries.map(({ relativePath, size, status }) => ({
        relativePath,
        size,
        status
      })),
      [
        {
          relativePath: "engine.snapshot",
          size: 21,
          status: "create"
        },
        {
          relativePath: "evidence/claim.json",
          size: 20,
          status: "create"
        }
      ]
    );

    await applyPortableRestorePlan(plan);
    assert.equal(
      readFileSync(join(target, "engine.snapshot"), "utf8"),
      "PRIVATE-ENGINE-CANARY"
    );
    assert.equal(
      readFileSync(join(target, "evidence", "claim.json"), "utf8"),
      '{"claim":"verified"}'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong recovery key and ciphertext tampering fail closed without writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-key-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(source);
  writeFileSync(join(source, "state.bin"), "encrypted state");

  try {
    const archive = await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["state.bin"],
      recoveryKey
    });

    await assert.rejects(
      planPortableRestore({
        archive,
        recoveryKey: "this is definitely the wrong recovery key",
        targetDirectory: target
      }),
      (error: unknown) =>
        error instanceof BackupError &&
        error.code === "BACKUP_DECRYPT_FAILED"
    );

    const tampered = Buffer.from(archive);
    const tamperIndex = tampered.length - 8;
    tampered[tamperIndex] = tampered[tamperIndex]! ^ 1;
    await assert.rejects(
      planPortableRestore({
        archive: tampered,
        recoveryKey,
        targetDirectory: target
      }),
      (error: unknown) =>
        error instanceof BackupError &&
        (error.code === "BACKUP_ARCHIVE_INVALID" ||
          error.code === "BACKUP_DECRYPT_FAILED")
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore verifies every decrypted file hash and size before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-integrity-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(source);
  writeFileSync(join(source, "state.bin"), "trusted state");

  try {
    const archive = await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["state.bin"],
      recoveryKey
    });
    const envelope = JSON.parse(archive.toString("utf8")) as TestEnvelope;
    const key = await deriveTestKey(
      recoveryKey,
      Buffer.from(envelope.kdf.salt, "base64"),
      {
        N: envelope.kdf.N,
        r: envelope.kdf.r,
        p: envelope.kdf.p,
        maxmem: envelope.kdf.maxmem
      }
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.cipher.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8")
    ) as TestPayload;
    payload.files[0]!.data = Buffer.from("modified state").toString("base64");

    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.cipher.iv, "base64")
    );
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload))),
      cipher.final()
    ]);
    envelope.cipher.tag = cipher.getAuthTag().toString("base64");
    envelope.ciphertext = ciphertext.toString("base64");

    await assert.rejects(
      planPortableRestore({
        archive: Buffer.from(JSON.stringify(envelope)),
        recoveryKey,
        targetDirectory: target
      }),
      (error: unknown) =>
        error instanceof BackupError &&
        error.code === "BACKUP_FILE_INTEGRITY_INVALID"
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup rejects traversal paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-path-"));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(root, "outside.txt"), "outside");

  try {
    await assert.rejects(
      createPortableBackup({
        sourceDirectory: source,
        relativePaths: ["../outside.txt"],
        recoveryKey
      }),
      (error: unknown) =>
        error instanceof BackupError && error.code === "BACKUP_PATH_UNSAFE"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects an archive with more files than its bounded native writer accepts", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-file-limit-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(source);
  const relativePaths = Array.from({ length: 257 }, (_, index) => `state-${String(index)}.txt`);
  for (const relativePath of relativePaths) writeFileSync(join(source, relativePath), "x");

  try {
    const archive = await createPortableBackup({ sourceDirectory: source, relativePaths, recoveryKey });
    await assert.rejects(
      planPortableRestore({ archive, recoveryKey, targetDirectory: target }),
      (error: unknown) => error instanceof BackupError && error.code === "BACKUP_LIMIT_EXCEEDED"
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup rejects a file reached through an intermediate Windows junction", {
  skip: process.platform !== "win32"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-junction-"));
  const source = join(root, "source");
  const outside = join(root, "outside");
  mkdirSync(source);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(outside, join(source, "linked"), "junction");

  try {
    await assert.rejects(
      createPortableBackup({
        sourceDirectory: source,
        relativePaths: ["linked/secret.txt"],
        recoveryKey
      }),
      (error: unknown) =>
        error instanceof BackupError && error.code === "BACKUP_SOURCE_INVALID"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface TestEnvelope {
  kdf: {
    salt: string;
    N: number;
    r: number;
    p: number;
    maxmem: number;
  };
  cipher: {
    iv: string;
    tag: string;
  };
  ciphertext: string;
}

interface TestPayload {
  files: Array<{
    path: string;
    data: string;
  }>;
}

function deriveTestKey(
  value: string,
  salt: Buffer,
  options: {
    N: number;
    r: number;
    p: number;
    maxmem: number;
  }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(value, salt, 32, options, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(key));
    });
  });
}
