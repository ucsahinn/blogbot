import assert from "node:assert/strict";
import {
  createDecipheriv,
  createCipheriv,
  randomBytes,
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
    const envelope = JSON.parse(archive.toString("utf8")) as { version: number; kdf: { N: number } };
    assert.equal(envelope.version, 2);
    assert.equal(envelope.kdf.N, 131_072);

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

test("portable restore remains compatible with a legacy v1 archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-v1-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(source);
  writeFileSync(join(source, "state.bin"), "legacy-compatible state");

  try {
    const current = await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["state.bin"],
      recoveryKey
    });
    const legacy = await rewritePortableArchiveAsV1(current);
    const plan = await planPortableRestore({
      archive: legacy,
      recoveryKey,
      targetDirectory: target
    });
    assert.equal(plan.entries[0]?.relativePath, "state.bin");
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

test("backup rejects Windows alternate data stream paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-ads-"));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "state.bin"), "base state");
  writeFileSync(join(source, "state.bin:probe"), "hidden stream");

  try {
    await assert.rejects(
      createPortableBackup({
        sourceDirectory: source,
        relativePaths: ["state.bin:probe"],
        recoveryKey
      }),
      (error: unknown) =>
        error instanceof BackupError && error.code === "BACKUP_PATH_UNSAFE"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects an encrypted archive entry targeting a Windows alternate data stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-restore-ads-"));
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
    const rewritten = await rewritePortableArchivePath(
      archive,
      "state.bin:probe"
    );

    await assert.rejects(
      planPortableRestore({
        archive: rewritten,
        recoveryKey,
        targetDirectory: target
      }),
      (error: unknown) =>
        error instanceof BackupError && error.code === "BACKUP_PATH_UNSAFE"
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects an archive with more files than its bounded native writer accepts", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-portable-backup-file-limit-"));
  const source = join(root, "source");
  const target = join(root, "restored");
  mkdirSync(source);
  writeFileSync(join(source, "state-0.txt"), "x");

  try {
    // `createPortableBackup` now refuses to build an over-limit archive, so this
    // one is crafted by re-encrypting a valid archive. The restore bound must
    // stay independent: an archive can come from another build or a tampered
    // file, and restore is the last line of defence.
    const archive = await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["state-0.txt"],
      recoveryKey
    });
    const envelope = JSON.parse(archive.toString("utf8")) as TestEnvelope;
    const key = await deriveTestKey(recoveryKey, Buffer.from(envelope.kdf.salt, "base64"), {
      N: envelope.kdf.N,
      r: envelope.kdf.r,
      p: envelope.kdf.p,
      maxmem: envelope.kdf.maxmem
    });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8")
    ) as TestPayload & { manifest: { files: Array<{ path: string; size: number; sha256: string }> } };

    const templateFile = payload.files[0]!;
    const templateManifest = payload.manifest.files[0]!;
    for (let index = 1; index < 257; index += 1) {
      const path = `state-${String(index)}.txt`;
      payload.files.push({ path, data: templateFile.data });
      payload.manifest.files.push({ ...templateManifest, path });
    }

    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64"));
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
  format: string;
  version: number;
  kdf: {
    name: string;
    salt: string;
    N: number;
    r: number;
    p: number;
    maxmem: number;
  };
  cipher: {
    name: string;
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

async function rewritePortableArchivePath(
  archive: Buffer,
  rewrittenPath: string
): Promise<Buffer> {
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
  try {
    const iv = Buffer.from(envelope.cipher.iv, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8")
    ) as TestPayload & {
      manifest: { files: Array<{ path: string; size: number; sha256: string }> };
    };
    payload.files[0]!.path = rewrittenPath;
    payload.manifest.files[0]!.path = rewrittenPath;

    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final()
    ]);
    envelope.cipher.tag = cipher.getAuthTag().toString("base64");
    envelope.ciphertext = ciphertext.toString("base64");
    return Buffer.from(JSON.stringify(envelope), "utf8");
  } finally {
    key.fill(0);
  }
}

async function rewritePortableArchiveAsV1(archive: Buffer): Promise<Buffer> {
  const envelope = JSON.parse(archive.toString("utf8")) as TestEnvelope;
  const currentKey = await deriveTestKey(
    recoveryKey,
    Buffer.from(envelope.kdf.salt, "base64"),
    { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p, maxmem: envelope.kdf.maxmem }
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    currentKey,
    Buffer.from(envelope.cipher.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "base64"));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8")
  ) as TestPayload & { manifest: { version: number } };
  currentKey.fill(0);
  payload.manifest.version = 1;
  const legacyKdf = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const salt = randomBytes(16);
  const key = await deriveTestKey(recoveryKey, salt, legacyKdf);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final()
    ]);
    return Buffer.from(JSON.stringify({
      ...envelope,
      version: 1,
      kdf: { name: "scrypt", salt: salt.toString("base64"), ...legacyKdf },
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
      ciphertext: ciphertext.toString("base64")
    }), "utf8");
  } finally {
    key.fill(0);
  }
}

test("a backup this build could never restore is refused instead of reported as created", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-backup-oversized-"));
  try {
    // One byte over the restore-side per-file limit. Creating this archive used
    // to succeed and report a sha256, but every verify/restore of it fails with
    // BACKUP_LIMIT_EXCEEDED — a successful backup that cannot be restored is a
    // false success in the one path the user relies on for recovery.
    writeFileSync(join(root, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

    await assert.rejects(
      () => createPortableBackup({
        sourceDirectory: root,
        relativePaths: ["large.bin"],
        recoveryKey,
        createdAt: "2026-08-19T10:00:00.000Z"
      }),
      (error: unknown) => {
        assert.ok(error instanceof BackupError, `expected BackupError, got ${String(error)}`);
        assert.equal(error.code, "BACKUP_LIMIT_EXCEEDED");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backup with more files than restore accepts is refused at creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-backup-too-many-"));
  try {
    const paths: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      const name = `file-${index}.txt`;
      writeFileSync(join(root, name), "x");
      paths.push(name);
    }

    await assert.rejects(
      () => createPortableBackup({
        sourceDirectory: root,
        relativePaths: paths,
        recoveryKey,
        createdAt: "2026-08-19T10:00:00.000Z"
      }),
      (error: unknown) => {
        assert.ok(error instanceof BackupError, `expected BackupError, got ${String(error)}`);
        assert.equal(error.code, "BACKUP_LIMIT_EXCEEDED");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
