import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as revisionDomain from "../../packages/editorial/src/revision.ts";
import {
  canonicalJson,
  computeWarningSetHash,
  computeRevisionHash,
  evaluatePublishEligibility,
  validateClaimEvidence,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval
} from "../../packages/editorial/src/revision.ts";

function revision(overrides: Partial<ArticleRevision> = {}): ArticleRevision {
  return {
    id: "rev-1",
    translationKey: "story-1",
    state: "APPROVED",
    tr: {
      title: "Kimlik güvenliği neden değişiyor?",
      slug: "kimlik-guvenligi-neden-degisiyor",
      description: "Kimlik güvenliğindeki dönüşümün kanıta dayalı özeti.",
      bodyMarkdown: "Özgün Türkçe metin.",
      heroImageAlt: "Soyut bir kimlik güvenliği illüstrasyonu"
    },
    en: {
      title: "Why identity security is changing",
      slug: "why-identity-security-is-changing",
      description: "An evidence-based account of the shift in identity security.",
      bodyMarkdown: "Original English localization.",
      heroImageAlt: "An abstract identity-security illustration"
    },
    section: "haberler",
    articleType: "news",
    author: "Yerel Editorya",
    tags: ["kimlik", "güvenlik"],
    claims: [
      {
        id: "claim-1",
        locale: "both",
        text: "Olay doğrulandı.",
        sourceIds: ["source-1"],
        status: "VERIFIED",
        claimKey: "claim.identity.event",
        trText: "Olay doğrulandı.",
        enText: "The event was verified.",
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash: "a".repeat(64),
            start: 10,
            end: 28
          }
        ]
      }
    ],
    sources: [
      {
        id: "source-1",
        url: "https://example.com/primary",
        title: "Primary source",
        fetchedAt: "2026-07-29T09:00:00.000Z",
        contentHash: "sha256:source",
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED"
      }
    ],
    media: [
      {
        role: "hero",
        path: "images/story-1-16x9.webp",
        sha256: "media-hash",
        width: 1600,
        height: 900
      }
    ],
    scheduledAt: "2026-07-30T09:00:00.000Z",
    adapterVersion: "1.0.0",
    ...overrides
  };
}

function v2Revision(
  overrides: Record<string, unknown> = {}
): ArticleRevision {
  return Object.assign(revision(), {
    editorialDesk: "Yerel Editorya",
    riskLevel: "STANDARD",
    translationParity: {
      status: "MATCHED",
      reportHash: "b".repeat(64)
    },
    editorialPolicyHash: "c".repeat(64),
    editorialReviewReportHash: "d".repeat(64),
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "e".repeat(40),
    generatedFiles: [
      {
        path: "src/content/articles/tr/story-1.md",
        sha256: "f".repeat(64),
        size: 2048
      }
    ],
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "1" },
      { id: "parity", group: "editorial", state: "PASS", detail: "Dil eşitliği doğrulandı.", policyVersion: "1" }
    ],
    ...overrides
  });
}

function approvalFor(value: ArticleRevision): Approval {
  return {
    revisionId: value.id,
    revisionHash: computeRevisionHash(value),
    deviceId: "device-1",
    approvedAt: "2026-07-29T10:00:00.000Z",
    warningSetHash: computeWarningSetHash(value.qualityGates ?? [])
  };
}

test("canonical JSON ignores object key order but preserves semantic values", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: "1" }));
});

test("canonical JSON normalizes Windows line endings and matches a golden vector", () => {
  const windows = canonicalJson({ b: [2, { z: "ç", a: true }], a: "x\r\ny" });
  const linux = canonicalJson({ a: "x\ny", b: [2, { a: true, z: "ç" }] });

  assert.equal(windows, linux);
  assert.equal(
    createHash("sha256").update(windows, "utf8").digest("hex"),
    "238b8d0946bb34efb96ff6327a480b4d706f4af1c22e844cd1b183037088ae6d"
  );
});

test("same revision has a stable SHA-256 hash", () => {
  const first = revision();
  const reordered = { ...first, tr: { ...first.tr } };

  assert.equal(computeRevisionHash(first), computeRevisionHash(reordered));
  assert.match(computeRevisionHash(first), /^[a-f0-9]{64}$/);
});

test("enriched claims require TR/EN parity and anchored snapshot evidence", () => {
  const original = revision();
  const enriched = revision({
    claims: [
      {
        ...original.claims[0]!,
        claimKey: "claim.identity.event",
        trText: "Olay doğrulandı.",
        enText: "The event was verified.",
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash: "a".repeat(64),
            start: 10,
            end: 28
          }
        ]
      }
    ]
  });
  assert.equal(validateClaimEvidence(enriched), true);

  const missingEnglish = revision({
    claims: [{ ...enriched.claims[0]!, enText: "" }]
  });
  assert.equal(validateClaimEvidence(missingEnglish), false);

  const unknownSource = revision({
    claims: [{
      ...enriched.claims[0]!,
      evidenceAnchors: [{ sourceId: "missing", quoteHash: "a".repeat(64) }]
    }]
  });
  assert.equal(validateClaimEvidence(unknownSource), false);
});

test("legacy claims without bilingual anchored evidence fail closed", () => {
  const claim = revision().claims[0]!;
  assert.equal(
    validateClaimEvidence(
      revision({
        claims: [
          {
            id: claim.id,
            locale: claim.locale,
            text: claim.text,
            sourceIds: claim.sourceIds,
            status: claim.status
          }
        ]
      })
    ),
    false
  );
});

test("invalid enriched claim evidence blocks publication", () => {
  const base = v2Revision();
  const original = v2Revision({
    claims: [{
      ...base.claims[0]!,
      claimKey: "claim.identity.event",
      trText: "Olay doğrulandı.",
      enText: "The event was verified.",
      evidenceAnchors: [{ sourceId: "source-1", quoteHash: "bad" }]
    }]
  });
  const approval = approvalFor(original);
  assert.deepEqual(
    evaluatePublishEligibility(original, approval, {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "INVALID_CLAIM_EVIDENCE" }
  );
});

test("any approved package field change invalidates approval", () => {
  const original = revision();
  const approval: Approval = {
    revisionId: original.id,
    revisionHash: computeRevisionHash(original),
    deviceId: "device-1",
    approvedAt: "2026-07-29T10:00:00.000Z"
  };

  const changed = revision({
    tr: { ...original.tr, bodyMarkdown: `${original.tr.bodyMarkdown} ` }
  });
  const result = evaluatePublishEligibility(changed, approval, {
    now: new Date("2026-07-30T09:05:00.000Z"),
    publishingPaused: false
  });

  assert.deepEqual(result, { eligible: false, reason: "APPROVAL_HASH_MISMATCH" });
});

test("approved revision is eligible inside six-hour compensation window", () => {
  const original = v2Revision();
  const approval = approvalFor(original);

  assert.deepEqual(
    evaluatePublishEligibility(original, approval, {
      now: new Date("2026-07-30T14:59:59.000Z"),
      publishingPaused: false
    }),
    { eligible: true }
  );
});

test("a superseded revision cannot publish when a successor points to it", () => {
  const original = v2Revision();
  const successor = v2Revision({
    id: "rev-2",
    supersedesRevisionId: original.id
  });

  assert.deepEqual(
    evaluatePublishEligibility(original, approvalFor(original), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false,
      revisionLineage: [successor]
    }),
    { eligible: false, reason: "REVISION_SUPERSEDED" }
  );
});

test("only approved source trust and rights evidence can publish", () => {
  const source = v2Revision().sources[0]!;
  const { trustStatus: _trustStatus, rightsStatus: _rightsStatus, ...legacySource } = source;
  const cases = [
    { source: legacySource, expected: { eligible: false, reason: "SOURCE_TRUST_NOT_APPROVED" } },
    { source: { ...source, trustStatus: "APPROVED", rightsStatus: "APPROVED" }, expected: { eligible: true } },
    { source: { ...source, trustStatus: "PENDING", rightsStatus: "APPROVED" }, expected: { eligible: false, reason: "SOURCE_TRUST_NOT_APPROVED" } },
    { source: { ...source, trustStatus: "REJECTED", rightsStatus: "APPROVED" }, expected: { eligible: false, reason: "SOURCE_TRUST_NOT_APPROVED" } },
    { source: { ...source, trustStatus: "APPROVED", rightsStatus: "PENDING" }, expected: { eligible: false, reason: "SOURCE_RIGHTS_NOT_APPROVED" } },
    { source: { ...source, trustStatus: "APPROVED", rightsStatus: "REJECTED" }, expected: { eligible: false, reason: "SOURCE_RIGHTS_NOT_APPROVED" } }
  ] as const;

  for (const testCase of cases) {
    const original = v2Revision({
      sources: [testCase.source]
    });

    assert.deepEqual(
      evaluatePublishEligibility(original, approvalFor(original), {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }),
      testCase.expected
    );
  }
});

test("publication past six hours requires a new time and approval", () => {
  const original = v2Revision();
  const approval = approvalFor(original);

  assert.deepEqual(
    evaluatePublishEligibility(original, approval, {
      now: new Date("2026-07-30T15:00:01.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "SCHEDULE_EXPIRED" }
  );
});

test("TR/EN parity mismatch blocks an otherwise approved revision", () => {
  const original = v2Revision({
    translationParity: {
      status: "MISMATCHED",
      reportHash: "b".repeat(64)
    }
  });
  const approval = approvalFor(original);

  assert.deepEqual(
    evaluatePublishEligibility(original, approval, {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "TRANSLATION_PARITY_MISMATCH" }
  );
});

test("high-risk revision requires a separate high-risk approval", () => {
  const original = v2Revision({ riskLevel: "HIGH" });
  const editorialApproval = approvalFor(original);

  assert.deepEqual(
    evaluatePublishEligibility(
      original,
      {
        editorial: editorialApproval,
        highRisk: null
      },
      {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }
    ),
    { eligible: false, reason: "HIGH_RISK_APPROVAL_REQUIRED" }
  );
});

test("separate exact-hash approvals make a high-risk revision eligible", () => {
  const original = v2Revision({ riskLevel: "HIGH" });
  const revisionHash = computeRevisionHash(original);
  const editorialApproval = approvalFor(original);
  const highRiskApproval: HighRiskApproval = {
    revisionId: original.id,
    revisionHash,
    deviceId: "device-1",
    approvedAt: "2026-07-29T10:01:00.000Z",
    approvalType: "HIGH_RISK",
    riskChecklistHash: "9".repeat(64),
    windowsReauthenticatedAt: "2026-07-29T10:00:30.000Z"
  };

  assert.deepEqual(
    evaluatePublishEligibility(
      original,
      {
        editorial: editorialApproval,
        highRisk: highRiskApproval
      },
      {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }
    ),
    { eligible: true }
  );
});

test("complete V2 revision package passes runtime validation", () => {
  const validateRevisionPackageV2 = (
    revisionDomain as unknown as {
      validateRevisionPackageV2(value: ArticleRevision): boolean;
    }
  ).validateRevisionPackageV2;

  assert.equal(validateRevisionPackageV2(v2Revision()), true);
});

test("immutable review revision becomes eligible through its external exact-hash approval", () => {
  const original = v2Revision({ state: "REVIEW_REQUIRED" });
  assert.deepEqual(
    evaluatePublishEligibility(original, approvalFor(original), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: true }
  );
  const drafting = v2Revision({ state: "DRAFTING" });
  assert.deepEqual(
    evaluatePublishEligibility(drafting, approvalFor(drafting), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "REVISION_NOT_APPROVED" }
  );
});

test("allowlisted warnings require an exact warning-set acceptance hash", () => {
  const original = v2Revision({
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "1" },
      { id: "SINGLE_OFFICIAL_SOURCE_EXCEPTION", group: "editorial", state: "WARN", detail: "Tek resmi kaynak istisnası.", policyVersion: "1" }
    ]
  });

  assert.deepEqual(
    evaluatePublishEligibility(original, approvalFor(original), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: true }
  );
  assert.deepEqual(
    evaluatePublishEligibility(original, { ...approvalFor(original), warningSetHash: "0".repeat(64) }, {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "WARNING_ACCEPTANCE_MISMATCH" }
  );
});

test("warning hash is order-independent but changes with warning evidence", () => {
  const first = [
    { id: "SINGLE_OFFICIAL_SOURCE_EXCEPTION", group: "editorial" as const, state: "WARN" as const, detail: "A", policyVersion: "1" },
    { id: "claims", group: "editorial" as const, state: "PASS" as const, detail: "B", policyVersion: "1" }
  ];
  assert.equal(computeWarningSetHash(first), computeWarningSetHash([...first].reverse()));
  assert.notEqual(
    computeWarningSetHash(first),
    computeWarningSetHash([{ ...first[0]!, detail: "Değişti" }, first[1]!])
  );
});

test("unallowlisted warnings and unrun gates fail closed", () => {
  for (const [state, id, expected] of [
    ["WARN", "UNREVIEWED_SECURITY_WARNING", "WARNING_NOT_ALLOWLISTED"],
    ["NOT_RUN", "seo", "QUALITY_GATES_NOT_READY"],
    ["BLOCK", "claims", "QUALITY_GATES_NOT_READY"]
  ] as const) {
    const original = v2Revision({
      qualityGates: [{ id, group: "editorial", state, detail: "Kontrol sonucu.", policyVersion: "1" }]
    });
    assert.deepEqual(
      evaluatePublishEligibility(original, approvalFor(original), {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }),
      { eligible: false, reason: expected }
    );
  }
});

test("V2 revision package rejects missing hashes and unsafe generated paths", () => {
  const validateRevisionPackageV2 = (
    revisionDomain as unknown as {
      validateRevisionPackageV2(value: ArticleRevision): boolean;
    }
  ).validateRevisionPackageV2;

  assert.equal(
    validateRevisionPackageV2(v2Revision({ editorialPolicyHash: "" })),
    false
  );
  assert.equal(
    validateRevisionPackageV2(v2Revision({
      generatedFiles: [
        {
          path: "../outside.md",
          sha256: "f".repeat(64),
          size: 2048
        }
      ]
    })),
    false
  );
});

test("partially migrated V2 package fails closed before publication", () => {
  const partial = Object.assign(revision(), {
    editorialDesk: "Yerel Editorya"
  });
  const approval: Approval = {
    revisionId: partial.id,
    revisionHash: computeRevisionHash(partial),
    deviceId: "device-1",
    approvedAt: "2026-07-29T10:00:00.000Z"
  };

  assert.deepEqual(
    evaluatePublishEligibility(partial, approval, {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "REVISION_PACKAGE_INCOMPLETE" }
  );
});

test("every V2 package field participates in exact-hash approval", () => {
  const original = v2Revision();
  const originalHash = computeRevisionHash(original);
  const mutations: ArticleRevision[] = [
    v2Revision({ editorialDesk: "Security Desk" }),
    v2Revision({ riskLevel: "HIGH" }),
    v2Revision({
      translationParity: {
        status: "MATCHED",
        reportHash: "1".repeat(64)
      }
    }),
    v2Revision({ editorialPolicyHash: "2".repeat(64) }),
    v2Revision({ editorialReviewReportHash: "3".repeat(64) }),
    v2Revision({ targetRepository: "ucsahinn/other-site" }),
    v2Revision({ targetBaseBranch: "production" }),
    v2Revision({ targetBaseSha: "4".repeat(40) }),
    v2Revision({
      generatedFiles: [
        {
          path: "src/content/articles/tr/story-1.md",
          sha256: "5".repeat(64),
          size: 2048
        }
      ]
    })
  ];

  for (const changed of mutations) {
    assert.notEqual(computeRevisionHash(changed), originalHash);
  }
});

test("stale high-risk approval is rejected independently", () => {
  const original = v2Revision({ riskLevel: "HIGH" });
  const editorialApproval = approvalFor(original);

  assert.deepEqual(
    evaluatePublishEligibility(
      original,
      {
        editorial: editorialApproval,
        highRisk: {
          revisionId: original.id,
          revisionHash: "0".repeat(64),
          deviceId: "device-1",
          approvedAt: "2026-07-29T10:01:00.000Z",
          approvalType: "HIGH_RISK",
          riskChecklistHash: "9".repeat(64),
          windowsReauthenticatedAt: "2026-07-29T10:00:30.000Z"
        }
      },
      {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }
    ),
    { eligible: false, reason: "HIGH_RISK_APPROVAL_HASH_MISMATCH" }
  );
});
