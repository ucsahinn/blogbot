import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import {
  computeRevisionHash,
  type ArticleRevision,
  type RevisionPackageV2
} from "../../packages/editorial/src/revision.ts";

function revision(
  overrides: Partial<RevisionPackageV2> = {}
): RevisionPackageV2 {
  return {
    id: "revision-editorial-1",
    translationKey: "story-editorial-1",
    state: "REVIEW_REQUIRED",
    tr: {
      title: "Kimlik güvenliği değişiyor",
      slug: "kimlik-guvenligi-degisiyor",
      description: "Doğrulanmış gelişmenin özgün Türkçe özeti.",
      bodyMarkdown: "## Özet\n\nDoğrulanmış gelişme [kaynakta](https://example.com/report) yer alıyor.",
      heroImageAlt: "Kimlik güvenliğini gösteren soyut kapak"
    },
    en: {
      title: "Identity security is changing",
      slug: "identity-security-is-changing",
      description: "An original English account of the verified development.",
      bodyMarkdown: "## Summary\n\nThe verified development appears in the [source](https://example.com/report).",
      heroImageAlt: "An abstract cover representing identity security"
    },
    section: "haberler",
    articleType: "news",
    author: "Ulaş Şahin",
    tags: ["kimlik", "güvenlik"],
    claims: [
      {
        id: "claim-1",
        locale: "both",
        text: "Gelişme doğrulandı.",
        sourceIds: ["source-1"],
        status: "VERIFIED",
        claimKey: "claim.identity.change",
        trText: "Gelişme doğrulandı.",
        enText: "The development was verified.",
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash: "a".repeat(64),
            start: 10,
            end: 40
          }
        ]
      }
    ],
    sources: [
      {
        id: "source-1",
        url: "https://example.com/report",
        title: "Primary report",
        fetchedAt: "2026-07-30T08:00:00.000Z",
        contentHash: "b".repeat(64)
      }
    ],
    media: [
      {
        role: "hero",
        path: "identity-security-16x9.webp",
        sha256: "c".repeat(64),
        width: 1600,
        height: 900
      }
    ],
    scheduledAt: "2026-07-30T12:00:00.000Z",
    adapterVersion: "2.0.0",
    editorialDesk: "SiberDergi Editorya",
    riskLevel: "STANDARD",
    translationParity: {
      status: "MATCHED",
      reportHash: "d".repeat(64)
    },
    editorialPolicyHash: "e".repeat(64),
    editorialReviewReportHash: "f".repeat(64),
    targetRepository: "ucsahinn/siberdergi.net",
    targetBaseBranch: "main",
    targetBaseSha: "1".repeat(40),
    generatedFiles: [
      {
        path: "src/content/articles/tr/kimlik-guvenligi-degisiyor.md",
        sha256: "2".repeat(64),
        size: 1_024
      },
      {
        path: "src/content/articles/en/identity-security-is-changing.md",
        sha256: "3".repeat(64),
        size: 960
      }
    ],
    ...overrides
  };
}

function command(
  kind: string,
  payload: Record<string, unknown>,
  expectedVersion: number,
  suffix: string
) {
  return {
    version: 1,
    id: `editorial-envelope-${suffix}`,
    kind: "command",
    command: {
      version: 1,
      requestId: `editorial-request-${suffix}`,
      idempotencyKey: `editorial-key-${suffix}`,
      expectedVersion,
      kind,
      payload
    }
  };
}

function valueOf<T>(response: Record<string, unknown>): T {
  assert.equal(response.ok, true);
  return (response.result as { value: T }).value;
}

test("revision save, list, and get are versioned, exact-hash bound, and durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-protocol-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedRevision = revision();

  const firstRuntime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  let firstRuntimeClosed = false;
  t.after(async () => {
    if (!firstRuntimeClosed) {
      await firstRuntime.close();
    }
  });
  const saved = await firstRuntime.handle(
    command("REVISION.SAVE", { revision: expectedRevision }, 0, "save")
  );
  assert.deepEqual(valueOf(saved), {
    revision: expectedRevision,
    revisionHash: computeRevisionHash(expectedRevision)
  });

  const listed = await firstRuntime.handle(
    command("REVISION.LIST", {}, 1, "list")
  );
  assert.deepEqual(valueOf(listed), [
    {
      revision: expectedRevision,
      revisionHash: computeRevisionHash(expectedRevision),
      editorialApproval: null,
      highRiskApproval: null
    }
  ]);
  await firstRuntime.close();
  firstRuntimeClosed = true;

  const secondRuntime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  t.after(() => secondRuntime.close());
  const loaded = await secondRuntime.handle(
    command(
      "REVISION.GET",
      { revisionId: expectedRevision.id },
      1,
      "get-after-restart"
    )
  );
  assert.deepEqual(valueOf<{
    revision: ArticleRevision;
    revisionHash: string;
    editorialApproval: null;
    highRiskApproval: null;
  }>(loaded), {
    revision: expectedRevision,
    revisionHash: computeRevisionHash(expectedRevision),
    editorialApproval: null,
    highRiskApproval: null
  });
});

test("normal approval is exact-hash bound, idempotent, and durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-approval-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  let closed = false;
  t.after(async () => {
    if (!closed) await runtime.close();
  });
  const expectedRevision = revision();
  const expectedHash = computeRevisionHash(expectedRevision);
  await runtime.handle(
    command("REVISION.SAVE", { revision: expectedRevision }, 0, "approve-save")
  );

  const rejected = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: "0".repeat(64),
        deviceId: "windows-local-device-v1"
      },
      1,
      "approve-wrong-hash"
    )
  );
  assert.equal(rejected.ok, false);

  const approved = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: expectedHash,
        deviceId: "windows-local-device-v1"
      },
      1,
      "approve"
    )
  );
  const approvalValue = valueOf<{
    revisionId: string;
    revisionHash: string;
    deviceId: string;
    approvedAt: string;
    approvalType: "EDITORIAL";
  }>(approved);
  assert.deepEqual(
    {
      ...approvalValue,
      approvedAt: "<engine-time>"
    },
    {
      revisionId: expectedRevision.id,
      revisionHash: expectedHash,
      deviceId: "windows-local-device-v1",
      approvedAt: "<engine-time>",
      approvalType: "EDITORIAL"
    }
  );
  assert.equal(
    new Date(approvalValue.approvedAt).toISOString(),
    approvalValue.approvedAt
  );
  const replay = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: expectedHash,
        deviceId: "windows-local-device-v1"
      },
      1,
      "approve"
    )
  );
  assert.deepEqual(replay, approved);
  await runtime.close();
  closed = true;

  const reopened = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  t.after(() => reopened.close());
  const listed = await reopened.handle(
    command("REVISION.LIST", {}, 2, "approval-list")
  );
  const rows = valueOf<
    Array<{ editorialApproval: { revisionHash: string } | null }>
  >(listed);
  assert.equal(rows[0]?.editorialApproval?.revisionHash, expectedHash);
});

test("normal approval rejects a revision that is not awaiting review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-state-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());

  const draftingRevision = revision({
    id: "revision-editorial-drafting",
    state: "DRAFTING"
  });
  const revisionHash = computeRevisionHash(draftingRevision);
  await runtime.handle(
    command(
      "REVISION.SAVE",
      { revision: draftingRevision },
      0,
      "drafting-save"
    )
  );

  const response = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: draftingRevision.id,
        revisionHash,
        deviceId: "windows-local-device-v1"
      },
      1,
      "drafting-approve"
    )
  );

  assert.equal(response.ok, false);
  assert.equal(
    (response.result as { error: { code: string } }).error.code,
    "REVISION_NOT_REVIEWABLE"
  );
});
