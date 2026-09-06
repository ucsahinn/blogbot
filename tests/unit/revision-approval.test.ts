import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as revisionDomain from "../../packages/editorial/src/revision.ts";
import {
  canonicalJson,
  computeWarningSetHash,
  computeRevisionHash,
  evaluatePublishEligibility,
  publicationSourcesFor,
  validateClaimEvidence,
  validateRevisionPackageV3,
  type Approval,
  type ApprovalV3,
  type ArticleRevision,
  type HighRiskApproval,
  type PublicationSourceV3,
  type RevisionPackageV3
} from "../../packages/editorial/src/revision.ts";
import type {
  EditorialApprovalAttestationV3,
  EditorialAssessmentV3
} from "../../packages/editorial/src/quality-gates.ts";

function revision(overrides: Partial<ArticleRevision> = {}): ArticleRevision {
  const evidenceExcerpt = "Primary source confirms the event occurred.";
  const quoteHash = createHash("sha256").update(evidenceExcerpt, "utf8").digest("hex");
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
        evidenceAnchors: [{
          sourceId: "source-1",
          quoteHash,
          start: 0,
          end: evidenceExcerpt.length
        }]
      }
    ],
    sources: [
      {
        id: "source-1",
        url: "https://example.com/primary",
        title: "Primary source",
        fetchedAt: "2026-07-29T09:00:00.000Z",
        contentHash: "a".repeat(64),
        evidenceExcerpt,
        evidenceExcerptHash: quoteHash,
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash,
            start: 0,
            end: evidenceExcerpt.length
          }
        ],
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
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "contradictions", group: "editorial", state: "PASS", detail: "Çelişki denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "bilingual-parity", group: "editorial", state: "PASS", detail: "Dil eşitliği doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "markdown-safety", group: "security", state: "PASS", detail: "Markdown güvenli.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "seo", group: "seo", state: "PASS", detail: "SEO denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "media", group: "media", state: "PASS", detail: "Medya denetlendi.", policyVersion: "2", reasonCode: "CHECKED" }
    ],
    ...overrides
  });
}

function v2Gates(
  replacements: NonNullable<ArticleRevision["qualityGates"]>
): NonNullable<ArticleRevision["qualityGates"]> {
  const baseline = v2Revision().qualityGates ?? [];
  const replacementById = new Map(replacements.map((gate) => [gate.id, gate]));
  return [
    ...baseline.map((gate) => replacementById.get(gate.id) ?? gate),
    ...replacements.filter((gate) => !baseline.some((candidate) => candidate.id === gate.id))
  ];
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function v3Assessment(
  overrides: Partial<EditorialAssessmentV3> = {}
): EditorialAssessmentV3 {
  return {
    articleType: "news",
    intentSatisfied: true,
    titleIsHonest: true,
    originalValuePresent: true,
    allClaimsVerified: true,
    sources: [
      { sourceId: "source-1", cited: true, official: true, role: "primary" },
      { sourceId: "source-2", cited: true, official: false, role: "independent" }
    ],
    singleOfficialSourceRationale: null,
    authorTransparent: true,
    aiDisclosureMatchesUsage: true,
    isYmyl: false,
    leadHasFiveWOneH: true,
    unverifiedClaimsClearlyLabeled: true,
    newsSchemaComplete: true,
    sensitiveTopic: false,
    clusterKey: null,
    aboveFoldAnswersIntent: true,
    headingHierarchyValid: true,
    internalLinkCount: 1,
    internalLinkOmissionRationale: null,
    ...overrides
  };
}

function v3Revision(
  overrides: Record<string, unknown> = {}
): RevisionPackageV3 {
  const instruction = "Kaynaklardan özgün ve iki dilli bir haber hazırla.";
  const secondSource = {
    id: "source-2",
    url: "https://example.net/independent",
    title: "Independent report",
    fetchedAt: "2026-07-29T09:05:00.000Z",
    contentHash: "9".repeat(64),
    trustStatus: "APPROVED" as const,
    rightsStatus: "APPROVED" as const
  };
  return Object.assign(v2Revision({
    qualityGates: v2Gates([{
      id: "editorial-policy",
      group: "editorial",
      state: "PASS",
      detail: "V3 editoryal politika değerlendirmesi onaya hazır.",
      policyVersion: "3",
      reasonCode: "CHECKED"
    }]),
    sources: [...revision().sources, secondSource]
  }), {
    packageVersion: 3 as const,
    editorialContext: {
      instruction,
      instructionHash: sha256(instruction),
      contentOrigin: "CODEX_ASSISTED" as const,
      aiDisclosure: "GENERATED_WITH_AI" as const
    },
    editorialAssessment: v3Assessment(),
    publicationSources: [
      {
        id: "source-1",
        title: "Primary source",
        url: "https://example.com/primary",
        role: "primary" as const
      },
      {
        id: "source-2",
        title: "Independent report",
        url: "https://example.net/independent",
        role: "independent" as const
      }
    ],
    deployWorkflow: "deploy.yml",
    requiredChecks: ["build", "test / windows"],
    ...overrides
  }) as RevisionPackageV3;
}

function v3Attestation(
  overrides: Partial<EditorialApprovalAttestationV3> = {}
): EditorialApprovalAttestationV3 {
  return {
    editorialReview: {
      reviewer: "Deniz Editör",
      sourceRoles: [
        { sourceId: "source-1", role: "primary" },
        { sourceId: "source-2", role: "independent" }
      ]
    },
    expertReview: null,
    ethicsReview: null,
    ...overrides
  };
}

function approvalV3For(
  value: RevisionPackageV3,
  attestation = v3Attestation()
): ApprovalV3 {
  return {
    ...approvalFor(value),
    packageVersion: 3,
    approvalType: "EDITORIAL",
    attestation,
    attestationHash: sha256(canonicalJson(attestation))
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
        evidenceAnchors: original.claims[0]!.evidenceAnchors ?? []
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

  const missingSnapshotAnchor = revision({
    sources: [{
      ...enriched.sources[0]!,
      evidenceAnchors: []
    }],
    claims: enriched.claims
  });
  assert.equal(validateClaimEvidence(missingSnapshotAnchor), false);
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

test("V2 revision package requires every typed quality gate exactly once", () => {
  const validateRevisionPackageV2 = (
    revisionDomain as unknown as {
      validateRevisionPackageV2(value: ArticleRevision): boolean;
    }
  ).validateRevisionPackageV2;
  const complete = v2Revision();
  assert.equal(validateRevisionPackageV2({
    ...complete,
    qualityGates: complete.qualityGates!.filter((gate) => gate.id !== "media")
  }), false);
  assert.equal(validateRevisionPackageV2({
    ...complete,
    qualityGates: complete.qualityGates!.map((gate) =>
      gate.id === "markdown-safety" ? { ...gate, group: "editorial" as const } : gate
    )
  }), false);
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
    qualityGates: v2Gates([
      { id: "seo", group: "seo", state: "WARN", detail: "Küçük SEO düzeltmesi önerildi.", policyVersion: "2", reasonCode: "SEO_POLISH" }
    ])
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
    ["WARN", "seo", "WARNING_NOT_ALLOWLISTED"],
    ["NOT_RUN", "seo", "QUALITY_GATES_NOT_READY"],
    ["BLOCK", "claims", "QUALITY_GATES_NOT_READY"]
  ] as const) {
    const original = v2Revision({
      qualityGates: v2Gates([{
        id,
        group: id === "seo" ? "seo" : "editorial",
        state,
        detail: "Kontrol sonucu.",
        policyVersion: "2",
        reasonCode: state === "WARN" ? "UNSPECIFIED" : "CHECKED"
      }])
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

test("V2 warnings require an explicit gate-specific reason code", () => {
  const withUnknownReason = v2Revision({
    qualityGates: v2Gates([{
      id: "seo", group: "seo", state: "WARN", detail: "İnceleme notu.", policyVersion: "2", reasonCode: "UNSPECIFIED"
    }])
  });
  const acceptedPolish = v2Revision({
    qualityGates: v2Gates([{
      id: "seo", group: "seo", state: "WARN", detail: "İnceleme notu.", policyVersion: "2", reasonCode: "SEO_POLISH"
    }])
  });

  assert.deepEqual(
    evaluatePublishEligibility(withUnknownReason, approvalFor(withUnknownReason), {
      now: new Date("2026-07-30T09:05:00.000Z"), publishingPaused: false
    }),
    { eligible: false, reason: "WARNING_NOT_ALLOWLISTED" }
  );
  assert.deepEqual(
    evaluatePublishEligibility(acceptedPolish, approvalFor(acceptedPolish), {
      now: new Date("2026-07-30T09:05:00.000Z"), publishingPaused: false
    }),
    { eligible: true }
  );
});

test("V2 warning hashes bind the typed reason without rewriting V1 hashes", () => {
  const legacy = [{ id: "seo", group: "seo" as const, state: "WARN" as const, detail: "A", policyVersion: "1" }];
  const v2Polish = [{ ...legacy[0]!, policyVersion: "2", reasonCode: "SEO_POLISH" }];
  const v2Other = [{ ...legacy[0]!, policyVersion: "2", reasonCode: "DISCLOSED_SOURCE_DISAGREEMENT" }];

  assert.notEqual(computeWarningSetHash(legacy), computeWarningSetHash(v2Polish));
  assert.notEqual(computeWarningSetHash(v2Polish), computeWarningSetHash(v2Other));
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

test("a package with no claims is never publishable on vacuous claim checks", () => {
  const claimless = v2Revision({ claims: [] });

  assert.deepEqual(
    evaluatePublishEligibility(claimless, approvalFor(claimless), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "NEEDS_SOURCE" }
  );
});

test("an own __proto__ key cannot collapse two revisions onto one hash", () => {
  // JSON.parse produces `__proto__` as a genuine own key, so anything arriving
  // over the NDJSON boundary can carry one.
  assert.throws(
    () => canonicalJson(JSON.parse('{"a":1,"__proto__":{"x":1}}')),
    /Unsafe canonical JSON key/u
  );
  assert.equal(canonicalJson(JSON.parse('{"a":1}')), '{"a":1}');

  const smuggled = v2Revision({
    translationParity: JSON.parse(`{"status":"MATCHED","reportHash":"${"b".repeat(64)}","__proto__":{"leak":true}}`)
  });
  assert.throws(() => computeRevisionHash(smuggled), /Unsafe canonical JSON key/u);
});

test("an extra publication-target gate reports its own block, not a generic package failure", () => {
  const validateRevisionPackageV2 = (
    revisionDomain as unknown as {
      validateRevisionPackageV2(value: ArticleRevision): boolean;
    }
  ).validateRevisionPackageV2;
  const withTargetGate = v2Revision({
    qualityGates: v2Gates([{
      id: "publication-target",
      group: "security",
      state: "NOT_RUN",
      detail: "Canlı hedefin tam depo ve temel SHA doğrulaması henüz çalıştırılmadı.",
      policyVersion: "2",
      reasonCode: "PUBLICATION_TARGET_UNVERIFIED"
    }])
  });

  assert.equal(withTargetGate.qualityGates?.length, 7);
  assert.equal(validateRevisionPackageV2(withTargetGate), true);
  assert.deepEqual(
    evaluatePublishEligibility(withTargetGate, approvalFor(withTargetGate), {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "QUALITY_GATES_NOT_READY" }
  );
});

test("the acceptable V1 warning allowlist holds gate ids only", () => {
  const allowlist = (
    revisionDomain as unknown as {
      ACCEPTABLE_EDITORIAL_WARNING_IDS: ReadonlySet<string>;
    }
  ).ACCEPTABLE_EDITORIAL_WARNING_IDS;
  const gateIds = new Set((v2Revision().qualityGates ?? []).map((gate) => gate.id));

  for (const id of allowlist) {
    assert.ok(gateIds.has(id), `${id} is compared against gate ids but is not one`);
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

test("the V2 golden revision hash remains unchanged by the V3 contract", () => {
  assert.equal(
    computeRevisionHash(v2Revision()),
    "9167f0538e7640e49130296f543ae8433191b56a3ec7c80a108f0087cedd9031"
  );
});

test("a complete V3 package validates and every approval-bound V3 field changes its hash", () => {
  const original = v3Revision();
  const originalHash = computeRevisionHash(original);
  const assessment = original.editorialAssessment;
  const source = assessment.sources[0]!;
  const publicationSource = original.publicationSources[0]!;
  const mutations: ArticleRevision[] = [
    v3Revision({ packageVersion: 2 }),
    v3Revision({
      editorialContext: { ...original.editorialContext, instruction: "Başka talimat" }
    }),
    v3Revision({
      editorialContext: { ...original.editorialContext, instructionHash: "1".repeat(64) }
    }),
    v3Revision({
      editorialContext: { ...original.editorialContext, contentOrigin: "HUMAN" }
    }),
    v3Revision({
      editorialContext: { ...original.editorialContext, aiDisclosure: "UNDISCLOSED" }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, articleType: "analysis" }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, intentSatisfied: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, titleIsHonest: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, originalValuePresent: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, allClaimsVerified: false }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        sources: [{ ...source, cited: false }, ...assessment.sources.slice(1)]
      }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        sources: [{ ...source, official: false }, ...assessment.sources.slice(1)]
      }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        sources: [{ ...source, role: "supporting" }, ...assessment.sources.slice(1)]
      }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        sources: [{ ...source, sourceId: "source-renamed" }, ...assessment.sources.slice(1)]
      }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        singleOfficialSourceRationale: "Tek resmi kayıt."
      }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, authorTransparent: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, aiDisclosureMatchesUsage: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, isYmyl: true }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, leadHasFiveWOneH: false }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        unverifiedClaimsClearlyLabeled: false
      }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, newsSchemaComplete: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, sensitiveTopic: true }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, clusterKey: "kimlik-guvenligi" }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, aboveFoldAnswersIntent: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, headingHierarchyValid: false }
    }),
    v3Revision({
      editorialAssessment: { ...assessment, internalLinkCount: 2 }
    }),
    v3Revision({
      editorialAssessment: {
        ...assessment,
        internalLinkOmissionRationale: "İlgili yerel içerik henüz yok."
      }
    }),
    v3Revision({
      publicationSources: [
        { ...publicationSource, id: "changed-id" },
        ...original.publicationSources.slice(1)
      ]
    }),
    v3Revision({
      publicationSources: [
        { ...publicationSource, title: "Changed title" },
        ...original.publicationSources.slice(1)
      ]
    }),
    v3Revision({
      publicationSources: [
        { ...publicationSource, url: "https://example.com/changed" },
        ...original.publicationSources.slice(1)
      ]
    }),
    v3Revision({
      publicationSources: [
        { ...publicationSource, role: "supporting" },
        ...original.publicationSources.slice(1)
      ]
    }),
    v3Revision({ deployWorkflow: "release.yml" }),
    v3Revision({ requiredChecks: ["build", "lint", "test / windows"] })
  ];

  assert.equal(validateRevisionPackageV3(original), true);
  for (const changed of mutations) {
    assert.notEqual(computeRevisionHash(changed), originalHash);
  }
});

test("incomplete and hybrid V3 packages fail closed", () => {
  const complete = v3Revision();
  const missingContext = v3Revision({ editorialContext: undefined });
  const hybrid = v3Revision();
  delete (hybrid as Partial<RevisionPackageV3>).packageVersion;

  assert.equal(validateRevisionPackageV3(missingContext), false);
  assert.equal(validateRevisionPackageV3(hybrid), false);
  assert.deepEqual(
    evaluatePublishEligibility(
      hybrid,
      approvalFor(hybrid),
      {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }
    ),
    { eligible: false, reason: "REVISION_PACKAGE_INCOMPLETE" }
  );
  assert.equal(validateRevisionPackageV3(complete), true);
});

test("V3 validates exact cited-source projection and normalized deploy policy", () => {
  const baseline = v3Revision();

  assert.equal(
    validateRevisionPackageV3(v3Revision({
      publicationSources: baseline.publicationSources.map((source) =>
        source.id === "source-1" ? { ...source, role: "supporting" } : source
      )
    })),
    false
  );
  assert.equal(
    validateRevisionPackageV3(v3Revision({
      publicationSources: baseline.publicationSources.slice(0, 1)
    })),
    false
  );
  assert.equal(
    validateRevisionPackageV3(v3Revision({
      requiredChecks: ["test / windows", "build"]
    })),
    false
  );
  assert.equal(
    validateRevisionPackageV3(v3Revision({
      requiredChecks: ["build", " build "]
    })),
    false
  );
  for (const deployWorkflow of ["../deploy.yml", "w".repeat(97) + ".yml", "a..yml", ".yml", "deploy.txt"]) {
    assert.equal(
      validateRevisionPackageV3(v3Revision({ deployWorkflow })),
      false,
      deployWorkflow
    );
  }
});

test("publication source projection never exposes private evidence fields", () => {
  const legacy = v2Revision({
    sources: [
      ...revision().sources,
      {
        id: "unused",
        url: "https://example.com/unused",
        title: "Unused source",
        fetchedAt: "2026-07-29T09:10:00.000Z",
        contentHash: "8".repeat(64),
        evidenceExcerpt: "Private unused evidence",
        evidenceExcerptHash: sha256("Private unused evidence"),
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED"
      }
    ]
  });

  const projected: PublicationSourceV3[] = publicationSourcesFor(legacy);
  assert.deepEqual(projected, [{
    id: "source-1",
    title: "Primary source",
    url: "https://example.com/primary",
    role: "supporting"
  }]);
  assert.equal(
    JSON.stringify(projected).includes("evidence"),
    false
  );
  assert.deepEqual(publicationSourcesFor(v3Revision()), v3Revision().publicationSources);
});

test("V3 exact-hash approval requires a complete matching editorial attestation", async (t) => {
  const now = new Date("2026-07-30T09:05:00.000Z");
  const cases: ReadonlyArray<readonly [string, RevisionPackageV3, EditorialApprovalAttestationV3]> = [
    [
      "named human reviewer",
      v3Revision(),
      v3Attestation({
        editorialReview: {
          reviewer: " ",
          sourceRoles: v3Attestation().editorialReview!.sourceRoles
        }
      })
    ],
    [
      "matching source-role attestation",
      v3Revision(),
      v3Attestation({
        editorialReview: {
          reviewer: "Deniz Editör",
          sourceRoles: [{ sourceId: "source-1", role: "supporting" }]
        }
      })
    ],
    [
      "complete expert review for YMYL",
      v3Revision({
        editorialAssessment: v3Assessment({ isYmyl: true })
      }),
      v3Attestation()
    ],
    [
      "complete ethics review for a sensitive topic",
      v3Revision({
        editorialAssessment: v3Assessment({ sensitiveTopic: true })
      }),
      v3Attestation()
    ]
  ];

  for (const [name, value, attestation] of cases) {
    await t.test(name, () => {
      assert.deepEqual(
        evaluatePublishEligibility(value, approvalV3For(value, attestation), {
          now,
          publishingPaused: false
        }),
        { eligible: false, reason: "EDITORIAL_ATTESTATION_INVALID" }
      );
    });
  }

  const complete = v3Revision({
    editorialAssessment: v3Assessment({ isYmyl: true, sensitiveTopic: true })
  });
  const completeAttestation = v3Attestation({
    expertReview: {
      reviewer: "Dr. Ada Uzman",
      qualifications: "Siber güvenlik ve risk uzmanı",
      reviewScope: "Yüksek etkili güvenlik iddiaları"
    },
    ethicsReview: {
      reviewer: "Etik Editörü",
      reviewScope: "Hassas kimlik verileri",
      rationale: "Zarar riski giderildi ve kamu yararı doğrulandı."
    }
  });
  assert.deepEqual(
    evaluatePublishEligibility(complete, approvalV3For(complete, completeAttestation), {
      now,
      publishingPaused: false
    }),
    { eligible: true }
  );
});

test("V3 rejects a stale attestation hash and deploy-policy mutations invalidate approval", () => {
  const original = v3Revision();
  const approval = approvalV3For(original);
  const staleAttestationApproval = {
    ...approval,
    attestationHash: "0".repeat(64)
  };

  assert.deepEqual(
    evaluatePublishEligibility(original, staleAttestationApproval, {
      now: new Date("2026-07-30T09:05:00.000Z"),
      publishingPaused: false
    }),
    { eligible: false, reason: "EDITORIAL_ATTESTATION_HASH_MISMATCH" }
  );

  for (const changed of [
    v3Revision({ deployWorkflow: "release.yml" }),
    v3Revision({ requiredChecks: ["build", "lint", "test / windows"] })
  ]) {
    assert.deepEqual(
      evaluatePublishEligibility(changed, approval, {
        now: new Date("2026-07-30T09:05:00.000Z"),
        publishingPaused: false
      }),
      { eligible: false, reason: "APPROVAL_HASH_MISMATCH" }
    );
  }
});
