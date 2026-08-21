import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from "node:crypto";

export interface EncryptedJsonEnvelopeV1 {
  v: 1;
  alg: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedJsonEnvelopeV2 {
  v: 2;
  alg: "A256GCM";
  /**
   * Truncated key identifier. Without it a failed open cannot say whether the
   * row was written under a different data key or was tampered with, which is
   * the difference between "restore the key" and "this database is corrupt".
   * Optional because rows sealed before it existed stay readable.
   */
  kid?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptionContext {
  table: string;
  key: string;
  field: string;
}

export class JsonProtector {
  private readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error("LOCAL_DATA_KEY_INVALID: AES-256-GCM requires 32 bytes");
    }
    this.keyId = createHmac("sha256", key)
      .update("blogbot-encrypted-json-key-id")
      .digest("hex")
      .slice(0, 16);
  }

  static fromEnvironment(): JsonProtector {
    const configured = process.env.BLOGBOT_DATA_KEY_HEX?.trim();
    if (configured && /^[a-f0-9]{64}$/iu.test(configured)) {
      return new JsonProtector(Buffer.from(configured, "hex"));
    }
    if (process.env.NODE_TEST_CONTEXT) {
      return new JsonProtector(
        createHash("sha256").update("blogbot-node-test-data-key").digest()
      );
    }
    throw new Error(
      "LOCAL_DATA_KEY_MISSING: the Windows DPAPI bridge did not provide a data key"
    );
  }

  seal(value: unknown, context: EncryptionContext): EncryptedJsonEnvelopeV2 {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(contextBytes(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final()
    ]);
    return {
      v: 2,
      alg: "A256GCM",
      kid: this.keyId,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  open<T>(value: unknown, context: EncryptionContext): T {
    if (!isEncryptedEnvelopeV2(value)) {
      throw new Error("LOCAL_DATA_ENVELOPE_INVALID");
    }
    if (value.kid !== undefined && value.kid !== this.keyId) {
      throw new Error("LOCAL_DATA_KEY_MISMATCH");
    }
    return this.openEnvelopeV2<T>(value, context);
  }

  /**
   * Reads a row written before the identity-bound v2 envelope existed. A legacy
   * plaintext row carries no proof of origin at all, so resealing whatever the
   * column happens to hold would turn arbitrary injected JSON into data that
   * passes every later authenticity check. The caller must therefore say what
   * shape it expects, and a v2 envelope is never unwrapped here: a v2 row
   * belongs to `open`, which verifies its identity binding.
   */
  openLegacy<T>(value: unknown, isExpectedRecord: (candidate: unknown) => boolean): T {
    if (isEncryptedEnvelopeV2(value)) {
      throw new Error(
        "LOCAL_DATA_LEGACY_UNVERIFIABLE: a v2 envelope cannot be resealed through the legacy path"
      );
    }
    const plaintext = isEncryptedEnvelopeV1(value)
      ? this.openEnvelopeV1<T>(value)
      : (structuredClone(value) as T);
    if (!isExpectedRecord(plaintext)) {
      throw new Error("LOCAL_DATA_LEGACY_UNVERIFIABLE");
    }
    return plaintext;
  }

  private openEnvelopeV1<T>(value: EncryptedJsonEnvelopeV1): T {
    return this.decrypt<T>(value);
  }

  private openEnvelopeV2<T>(
    value: EncryptedJsonEnvelopeV2,
    context: EncryptionContext
  ): T {
    return this.decrypt<T>(value, contextBytes(context));
  }

  private decrypt<T>(
    value: EncryptedJsonEnvelopeV1 | EncryptedJsonEnvelopeV2,
    aad?: Buffer
  ): T {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(value.iv, "base64")
      );
      if (aad) {
        decipher.setAAD(aad);
      }
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch (error) {
      throw new Error("LOCAL_DATA_DECRYPT_FAILED", { cause: error });
    }
  }
}

export function isEncryptedEnvelope(
  value: unknown
): value is EncryptedJsonEnvelopeV1 | EncryptedJsonEnvelopeV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.v === 1 || candidate.v === 2) &&
    candidate.alg === "A256GCM" &&
    (candidate.kid === undefined || typeof candidate.kid === "string") &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ciphertext === "string"
  );
}

export function isEncryptedEnvelopeV1(
  value: unknown
): value is EncryptedJsonEnvelopeV1 {
  return isEncryptedEnvelope(value) && value.v === 1;
}

export function isEncryptedEnvelopeV2(
  value: unknown
): value is EncryptedJsonEnvelopeV2 {
  return isEncryptedEnvelope(value) && value.v === 2;
}

function contextBytes(context: EncryptionContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: "blogbot-encrypted-json-v2",
      table: context.table,
      key: context.key,
      field: context.field
    }),
    "utf8"
  );
}
