import assert from "node:assert/strict";
import test from "node:test";

import {
  SITE_SECTIONS,
  normalizeSourceBatchInput,
  parseOpmlSourceUrls,
  validateEngineCommandV1
} from "../../packages/contracts/src/index.ts";

test("site routing contract keeps reciprocal TR and EN sections and schema types", () => {
  assert.deepEqual(SITE_SECTIONS.haberler, {
    trPath: "haberler",
    enPath: "news",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.equal(SITE_SECTIONS.rehberler.enPath, "guides");
  assert.equal(SITE_SECTIONS.dosyalar.enPath, "deep-dives");
});

test("general blog and news targets have clear, publishable section contracts", () => {
  assert.deepEqual(SITE_SECTIONS.teknoloji, {
    trPath: "teknoloji",
    enPath: "technology",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.deepEqual(SITE_SECTIONS.ekonomi, {
    trPath: "ekonomi",
    enPath: "business",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.equal(SITE_SECTIONS.kultur.articleType, "analysis");
  assert.equal(SITE_SECTIONS.yasam.articleType, "guide");
});

test("bulk source input has no artificial product cap and removes exact duplicates", () => {
  const urls = Array.from(
    { length: 500 },
    (_, index) => `https://source-${index}.example/feed`
  );
  const result = normalizeSourceBatchInput(`${urls.join("\n")}\n${urls[0]}`);

  assert.equal(result.urls.length, 500);
  assert.deepEqual(result.invalid, []);
});

test("OPML import reads xmlUrl and htmlUrl candidates without executing markup", () => {
  const result = parseOpmlSourceUrls(`
    <opml version="2.0">
      <body>
        <outline text="Feed" xmlUrl="https://example.com/rss.xml" />
        <outline text="Site" htmlUrl="https://another.example/news" />
        <script>alert(1)</script>
      </body>
    </opml>
  `);

  assert.deepEqual(result, [
    "https://example.com/rss.xml",
    "https://another.example/news"
  ]);
});

test("SOURCE.SCAN requires unique versioned targets and a batch expectedVersion of zero", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "scan-request-1",
    idempotencyKey: "scan-key-1",
    expectedVersion: 0,
    kind: "SOURCE.SCAN",
    payload: {
      targets: [
        { sourceId: "source-a", expectedVersion: 1 },
        { sourceId: "source-b", expectedVersion: 4 }
      ]
    }
  });
  assert.equal(valid.valid, true);

  for (const targets of [
    [],
    [
      { sourceId: "source-a", expectedVersion: 1 },
      { sourceId: "source-a", expectedVersion: 1 }
    ],
    [{ sourceId: "source-a", expectedVersion: -1 }]
  ]) {
    const result = validateEngineCommandV1({
      version: 1,
      requestId: "scan-request-invalid",
      idempotencyKey: "scan-key-invalid",
      expectedVersion: 0,
      kind: "SOURCE.SCAN",
      payload: { targets }
    });
    assert.equal(result.valid, false);
  }

  const nonZeroBatchVersion = validateEngineCommandV1({
    version: 1,
    requestId: "scan-request-version",
    idempotencyKey: "scan-key-version",
    expectedVersion: 1,
    kind: "SOURCE.SCAN",
    payload: {
      targets: [{ sourceId: "source-a", expectedVersion: 1 }]
    }
  });
  assert.equal(nonZeroBatchVersion.valid, false);
});

test("SOURCE.REVIEW records separate trust and usage-rights decisions with a version lock", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "source-review-request",
    idempotencyKey: "source-review-key",
    expectedVersion: 3,
    kind: "SOURCE.REVIEW",
    payload: {
      sourceId: "source-a",
      trustStatus: "APPROVED",
      rightsStatus: "REJECTED",
      rationale: "Yayıncının açık kullanım izni doğrulanamadı; kaynak yalnızca tarama için tutuluyor."
    }
  });
  assert.equal(valid.valid, true);

  for (const payload of [
    { sourceId: "source-a", trustStatus: "PENDING", rightsStatus: "APPROVED", rationale: "Yeterli gerekçe metni" },
    { sourceId: "source-a", trustStatus: "APPROVED", rightsStatus: "APPROVED", rationale: "kısa" },
    { sourceId: "", trustStatus: "APPROVED", rightsStatus: "APPROVED", rationale: "Kaynak sahipliği ve kullanım koşulları doğrulandı." }
  ]) {
    const result = validateEngineCommandV1({
      version: 1,
      requestId: "source-review-invalid",
      idempotencyKey: "source-review-invalid-key",
      expectedVersion: 3,
      kind: "SOURCE.REVIEW",
      payload
    });
    assert.equal(result.valid, false);
  }
});

test("APPROVAL.GRANT_HIGH_RISK requires exact hashes and a UTC reauthentication timestamp", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "high-risk-request",
    idempotencyKey: "high-risk-key",
    expectedVersion: 3,
    kind: "APPROVAL.GRANT_HIGH_RISK",
    payload: {
      revisionId: "revision-high-risk",
      revisionHash: "a".repeat(64),
      deviceId: "windows-local-device-v1",
      riskChecklistHash: "b".repeat(64),
      warningSetHash: "c".repeat(64),
      windowsReauthenticatedAt: "2026-07-30T12:00:00.000Z"
    }
  });
  assert.equal(valid.valid, true);

  const invalid = validateEngineCommandV1({
    version: 1,
    requestId: "high-risk-invalid",
    idempotencyKey: "high-risk-invalid-key",
    expectedVersion: 3,
    kind: "APPROVAL.GRANT_HIGH_RISK",
    payload: {
      revisionId: "revision-high-risk",
      revisionHash: "a".repeat(64),
      deviceId: "windows-local-device-v1",
      riskChecklistHash: "b".repeat(64),
      warningSetHash: "c".repeat(64),
      windowsReauthenticatedAt: "2026-07-30T12:00:00Z"
    }
  });
  assert.equal(invalid.valid, false);
});

test("APPROVAL.GRANT preserves the exact legacy payload and accepts only complete human V3 attestations", () => {
  const base = {
    version: 1,
    requestId: "approval-request",
    idempotencyKey: "approval-key",
    expectedVersion: 7,
    kind: "APPROVAL.GRANT"
  } as const;
  const legacyPayload = {
    revisionId: "revision-legacy",
    revisionHash: "A".repeat(64),
    deviceId: "windows-local-device-v1",
    warningSetHash: "B".repeat(64)
  };
  const legacy = validateEngineCommandV1({ ...base, payload: legacyPayload });
  assert.equal(legacy.valid, true);
  if (legacy.valid) {
    assert.deepEqual(legacy.command.payload, {
      ...legacyPayload,
      revisionHash: "a".repeat(64),
      warningSetHash: "b".repeat(64)
    });
  }
  assert.equal(
    validateEngineCommandV1({ ...base, payload: { ...legacyPayload, packageVersion: 3 } }).valid,
    false
  );

  const attestation = {
    editorialReview: {
      reviewer: "Deniz Editor",
      sourceRoles: [
        { sourceId: "source-primary", role: "primary" },
        { sourceId: "source-independent", role: "independent" }
      ]
    },
    expertReview: {
      reviewer: "Dr. Ada Uzman",
      qualifications: "Siber guvenlik ve risk uzmani",
      reviewScope: "Yuksek etkili guvenlik iddialari"
    },
    ethicsReview: {
      reviewer: "Etik Editoru",
      reviewScope: "Hassas kimlik verileri",
      rationale: "Zarar riski ve kamu yarari insan editor tarafindan degerlendirildi."
    }
  } as const;
  const v3Payload = {
    packageVersion: 3,
    revisionId: "revision-v3",
    revisionHash: "C".repeat(64),
    deviceId: "windows-local-device-v1",
    warningSetHash: "D".repeat(64),
    attestation
  };
  const v3 = validateEngineCommandV1({ ...base, payload: v3Payload });
  assert.equal(v3.valid, true);
  if (v3.valid) {
    assert.deepEqual(v3.command.payload, {
      ...v3Payload,
      revisionHash: "c".repeat(64),
      warningSetHash: "d".repeat(64)
    });
  }
  assert.equal(
    validateEngineCommandV1({
      ...base,
      payload: {
        ...v3Payload,
        attestation: { ...attestation, expertReview: null, ethicsReview: null }
      }
    }).valid,
    true
  );

  const invalidPayloads = [
    { ...v3Payload, unexpected: true },
    { ...legacyPayload, attestation },
    { ...v3Payload, packageVersion: 2 },
    { ...v3Payload, attestation: { ...attestation, model: "codex" } },
    {
      ...v3Payload,
      attestation: {
        ...attestation,
        editorialReview: { reviewer: " ", sourceRoles: attestation.editorialReview.sourceRoles }
      }
    },
    {
      ...v3Payload,
      attestation: {
        ...attestation,
        editorialReview: { reviewer: "Deniz Editor", sourceRoles: [] }
      }
    },
    {
      ...v3Payload,
      attestation: {
        ...attestation,
        editorialReview: {
          reviewer: "Deniz Editor",
          sourceRoles: [
            { sourceId: "source-primary", role: "primary" },
            { sourceId: "source-primary", role: "supporting" }
          ]
        }
      }
    },
    {
      ...v3Payload,
      attestation: {
        ...attestation,
        expertReview: { reviewer: "Dr. Ada", qualifications: " ", reviewScope: "Claims" }
      }
    },
    {
      ...v3Payload,
      attestation: {
        ...attestation,
        ethicsReview: { reviewer: "Etik Editoru", reviewScope: "Claims", rationale: "" }
      }
    }
  ];
  for (const payload of invalidPayloads) {
    assert.equal(validateEngineCommandV1({ ...base, payload }).valid, false);
  }
});

test("REVISION.SAVE fails closed on incomplete or malformed nested claims", () => {
  for (const revision of [
    {},
    {
      editorialDesk: "Yerel Editorya",
      riskLevel: "STANDARD",
      translationParity: { status: "MATCHED", reportHash: "a".repeat(64) },
      editorialPolicyHash: "b".repeat(64),
      editorialReviewReportHash: "c".repeat(64),
      targetRepository: "owner/site",
      targetBaseBranch: "main",
      targetBaseSha: "d".repeat(40),
      generatedFiles: [
        { path: "src/content/article.md", sha256: "e".repeat(64), size: 10 }
      ],
      claims: [null]
    }
  ]) {
    assert.doesNotThrow(() => {
      const result = validateEngineCommandV1({
        version: 1,
        requestId: "revision-invalid",
        idempotencyKey: "revision-invalid-key",
        expectedVersion: 0,
        kind: "REVISION.SAVE",
        payload: { revision }
      });
      assert.equal(result.valid, false);
    });
  }
});

function productionV2Revision(media: unknown[]) {
  return {
    id: "revision-contract-v2",
    translationKey: "story-contract-v2",
    state: "REVIEW_REQUIRED",
    tr: {
      title: "Doğrulanmış haber",
      slug: "dogrulanmis-haber",
      description: "Doğrulanmış haber açıklaması.",
      bodyMarkdown: "## Özet\\n\\nDoğrulanmış haber metni.",
      heroImageAlt: "Doğrulanmış haber kapağı"
    },
    en: {
      title: "Verified story",
      slug: "verified-story",
      description: "A verified story description.",
      bodyMarkdown: "## Summary\\n\\nVerified story copy.",
      heroImageAlt: "Verified story cover"
    },
    section: "haberler",
    articleType: "news",
    author: "Yerel Editör",
    tags: ["güvenlik"],
    claims: [{
      id: "claim-contract-v2",
      locale: "both",
      text: "İddia doğrulandı.",
      sourceIds: ["source-contract-v2"],
      status: "VERIFIED",
      claimKey: "claim.contract.v2",
      trText: "İddia doğrulandı.",
      enText: "The claim was verified.",
      evidenceAnchors: [{
        sourceId: "source-contract-v2",
        quoteHash: "a".repeat(64),
        start: 0,
        end: 10
      }]
    }],
    sources: [{
      id: "source-contract-v2",
      url: "https://example.com/report",
      title: "Primary report",
      fetchedAt: "2026-08-19T08:00:00.000Z",
      contentHash: "b".repeat(64),
      evidenceAnchors: [{
        sourceId: "source-contract-v2",
        quoteHash: "a".repeat(64),
        start: 0,
        end: 10
      }],
      trustStatus: "APPROVED",
      rightsStatus: "APPROVED"
    }],
    media,
    scheduledAt: "2026-08-20T12:00:00.000Z",
    adapterVersion: "astro-generic@1",
    editorialDesk: "Yerel Editorya",
    riskLevel: "STANDARD",
    translationParity: { status: "MATCHED", reportHash: "c".repeat(64) },
    editorialPolicyHash: "d".repeat(64),
    editorialReviewReportHash: "e".repeat(64),
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "f".repeat(40),
    generatedFiles: [{
      path: "src/content/articles/tr/dogrulanmis-haber.md",
      sha256: "1".repeat(64),
      size: 1_024
    }],
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "contradictions", group: "editorial", state: "PASS", detail: "Çelişki denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "bilingual-parity", group: "editorial", state: "PASS", detail: "Dil eşitliği doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "markdown-safety", group: "security", state: "PASS", detail: "Markdown güvenli.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "seo", group: "seo", state: "PASS", detail: "SEO denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "media", group: "media", state: "PASS", detail: "Medya denetlendi.", policyVersion: "2", reasonCode: "CHECKED" }
    ]
  };
}

test("REVISION.SAVE accepts production V2 media and rejects missing heroes or unbounded shapes", () => {
  const base = {
    version: 1,
    requestId: "revision-media-contract",
    idempotencyKey: "revision-media-contract-key",
    expectedVersion: 0,
    kind: "REVISION.SAVE"
  } as const;
  const hero = {
    role: "hero",
    path: "media/revision-contract-v2/hero.webp",
    sha256: "2".repeat(64),
    width: 1600,
    height: 900,
    byteSize: 1_024,
    contentBase64: "AA==",
    source: "LOCAL_RENDERER"
  };

  assert.equal(validateEngineCommandV1({
    ...base,
    payload: { revision: productionV2Revision([hero]) }
  }).valid, true);

  for (const media of [
    [],
    [{ ...hero, role: "inline" }],
    [{ ...hero, byteSize: 0 }],
    [{ ...hero, byteSize: 32 * 1024 * 1024 + 1 }],
    [{ ...hero, contentBase64: 42 }],
    [{ ...hero, source: "UNTRUSTED" }],
    [null, hero],
    [{ ...hero, unexpected: true }]
  ]) {
    assert.doesNotThrow(() => {
      assert.equal(validateEngineCommandV1({
        ...base,
        payload: { revision: productionV2Revision(media) }
      }).valid, false);
    });
  }
});

test("local workflow commands use exact, bounded shared command contracts", () => {
  const base = {
    version: 1,
    requestId: "local-contract-request",
    idempotencyKey: "local-contract-key",
    expectedVersion: 0
  } as const;
  const validCommands = [
    {
      ...base,
      kind: "DRAFT.CREATE",
      payload: {
        draftId: "draft-contract-1",
        instruction: "Kaynakları karşılaştır",
        sourceIds: ["source-1"],
        urls: [],
        section: "haberler",
        articleType: "news",
        urgency: "normal",
        tone: "neutral",
        length: "standard",
        visualPolicy: "GENERATE",
        scheduleIntent: "UNSCHEDULED"
      }
    },
    {
      ...base,
      kind: "BOBY.GUIDE",
      payload: {
        guidanceId: "boby-guidance-contract-1",
        question: "Taslağı nerede incelerim?",
        activePage: "content",
        runtimeState: "ONLINE",
        sessionId: "boby-session-1",
        safeWorkspaceSummary: { draftCount: 2, reviewCount: 1, sourceCount: 3 }
      }
    },
    { ...base, kind: "JOB.RETRY", payload: { jobId: "job-contract-1" } },
    { ...base, kind: "LOCAL_STATE.SET", payload: { key: "desktop.editorial", value: { mode: "ready" } } }
  ];
  for (const command of validCommands) {
    assert.equal(validateEngineCommandV1(command).valid, true, command.kind);
    assert.equal(
      validateEngineCommandV1({ ...command, payload: { ...command.payload, unexpected: true } }).valid,
      false,
      `${command.kind} must reject extra payload keys`
    );
  }
  assert.equal(validateEngineCommandV1({
    ...base,
    kind: "DRAFT.CREATE",
    payload: { draftId: "draft-native-null", sourceIds: ["source-1"], candidateUrl: null }
  }).valid, true, "native candidate payloads encode an absent candidateUrl as null");
  assert.equal(validateEngineCommandV1({
    ...base,
    kind: "BOBY.GUIDE",
    payload: {
      guidanceId: "boby-native-null",
      question: "Sonraki adım ne?",
      activePage: "content",
      runtimeState: "ONLINE",
      sessionId: null,
      safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
    }
  }).valid, true, "native Boby payloads encode an absent sessionId as null");

  const invalidCommands = [
    { ...base, kind: "DRAFT.CREATE", payload: { draftId: "draft-contract-1", sourceIds: [""] } },
    {
      ...base,
      kind: "BOBY.GUIDE",
      payload: {
        guidanceId: "boby-guidance-contract-1",
        question: " ",
        activePage: "content",
        runtimeState: "ONLINE",
        safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
      }
    },
    { ...base, kind: "JOB.RETRY", payload: {} },
    { ...base, kind: "LOCAL_STATE.SET", payload: { key: "", value: null } },
    { ...base, kind: "LOCAL_STATE.SET", payload: { key: "desktop.editorial", value: { text: "x".repeat(256_001) } } }
  ];
  for (const command of invalidCommands) {
    assert.equal(validateEngineCommandV1(command).valid, false, command.kind);
  }
});
