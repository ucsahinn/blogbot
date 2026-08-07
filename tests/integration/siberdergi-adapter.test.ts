import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  computeRevisionHash,
  type Approval,
  type ArticleRevision,
  type RevisionPackageV2
} from "../../packages/editorial/src/revision.ts";
import {
  isAllowedSiberDergiContentPath,
  buildSiberDergiIndexFiles,
  parseSiberDergiDocument,
  planSiberDergiPublication,
  SiberDergiContractError,
  type SiberDergiPublicationInput,
  type VirtualSiteFixture
} from "../../packages/siberdergi/src/adapter.ts";

test("site adapter builds crawl indexes and keeps the news sitemap inside the 48-hour window", () => {
  const files = buildSiberDergiIndexFiles(
    planSiberDergiPublication(
      publication({
        publishedAt: "2026-07-29T10:00:00.000Z",
        modifiedAt: "2026-07-29T10:00:00.000Z"
      }),
      { files: {} },
      { now: "2026-07-29T10:30:00.000Z" }
    ).nextFixture,
    "2026-07-29T11:00:00.000Z"
  );
  assert.match(files["public/sitemap.xml"] ?? "", /https:\/\/siberdergi\.net\/haberler\/sifir-guven-yaklasiminda-yeni-donem/);
  assert.match(files["public/news-sitemap.xml"] ?? "", /<news:publication_date>2026-07-29T10:00:00.000Z<\/news:publication_date>/);
  assert.match(files["public/robots.txt"] ?? "", /Sitemap: https:\/\/siberdergi\.net\/sitemap\.xml/);
  assert.match(files["public/rss.xml"] ?? "", /<rss version="2\.0"/);
  assert.match(files["public/en/rss.xml"] ?? "", /<language>en-US<\/language>/);
});

import {
  materializeApprovedSiberDergiBundle,
  parseSiberDergiArtifactManifest,
  type ApprovedMediaFile
} from "../../packages/siberdergi/src/bundle.ts";

const APPROVED_HASH = "a".repeat(64);

function fixture(): VirtualSiteFixture {
  return {
    files: JSON.parse(
      readFileSync(
        new URL("../../fixtures/siberdergi/site-files.json", import.meta.url),
        "utf8"
      )
    ) as Record<string, string>
  };
}

function publication(
  overrides: Partial<SiberDergiPublicationInput> = {}
): SiberDergiPublicationInput {
  return {
    revisionId: "revision-001",
    revisionHash: APPROVED_HASH,
    approval: {
      revisionHash: APPROVED_HASH,
      approvedAt: "2026-07-29T09:00:00.000Z"
    },
    translationKey: "zero-trust-july-2026",
    section: "haberler",
    articleType: "news",
    author: "SiberDergi",
    tags: ["sıfır güven", "kimlik"],
    publishedAt: "2026-07-29T10:00:00.000Z",
    modifiedAt: "2026-07-29T10:30:00.000Z",
    tr: {
      title: "Sıfır güven yaklaşımında yeni dönem",
      slug: "sifir-guven-yaklasiminda-yeni-donem",
      description: "Yeni yaklaşımın doğrulanmış kaynaklara dayalı özeti.",
      bodyMarkdown:
        "## Ne değişti?\n\nKuruluşlar kimlik denetimlerini yeniden ele alıyor.\n\n[Birincil kaynak](https://example.com/report)"
    },
    en: {
      title: "A new phase for zero trust",
      slug: "a-new-phase-for-zero-trust",
      description: "An evidence-based summary of the new approach.",
      bodyMarkdown:
        "## What changed?\n\nOrganizations are reassessing identity controls.\n\n[Primary source](https://example.com/report)"
    },
    sources: [
      {
        title: "Primary security report",
        url: "https://example.com/report",
        accessedAt: "2026-07-29T08:00:00.000Z"
      }
    ],
    ...overrides
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const approvedMedia = [
  {
    path: "hero-wide.webp",
    content: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
  },
  {
    path: "hero-square.webp",
    content: new Uint8Array([82, 73, 70, 70, 5, 6, 7, 8])
  }
] satisfies ApprovedMediaFile[];

function articleRevision(
  overrides: Partial<ArticleRevision> = {}
): ArticleRevision {
  return {
    id: "rev-7",
    translationKey: "zero-trust-july-2026",
    state: "APPROVED",
    tr: {
      title: "Sıfır güven yaklaşımında yeni dönem",
      slug: "sifir-guven-yaklasiminda-yeni-donem",
      description: "Yeni yaklaşımın doğrulanmış kaynaklara dayalı özeti.",
      bodyMarkdown: "## Ne değişti?\n\nKimlik denetimleri yeniden ele alınıyor.",
      heroImageAlt: "Sıfır güven katmanlarını gösteren özgün kapak"
    },
    en: {
      title: "A new phase for zero trust",
      slug: "a-new-phase-for-zero-trust",
      description: "An evidence-based summary of the new approach.",
      bodyMarkdown: "## What changed?\n\nIdentity controls are being reassessed.",
      heroImageAlt: "An original cover showing zero-trust layers"
    },
    section: "haberler",
    articleType: "news",
    author: "SiberDergi",
    tags: ["kimlik", "sıfır güven"],
    claims: [
      {
        id: "claim-1",
        locale: "both",
        text: "Kimlik denetimleri yeniden değerlendiriliyor.",
        sourceIds: ["source-1"],
        status: "VERIFIED",
        claimKey: "claim.identity-controls",
        trText: "Kimlik denetimleri yeniden değerlendiriliyor.",
        enText: "Identity controls are being reassessed.",
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash: "a".repeat(64),
            start: 0,
            end: 42
          }
        ]
      }
    ],
    sources: [
      {
        id: "source-1",
        url: "https://example.com/report",
        title: "Primary security report",
        fetchedAt: "2026-07-29T08:00:00.000Z",
        contentHash: "sha256:source-snapshot"
      }
    ],
    media: [
      {
        role: "hero",
        path: approvedMedia[0]!.path,
        sha256: sha256(approvedMedia[0]!.content),
        width: 1600,
        height: 900
      },
      {
        role: "inline",
        path: approvedMedia[1]!.path,
        sha256: sha256(approvedMedia[1]!.content),
        width: 1200,
        height: 1200
      }
    ],
    scheduledAt: "2026-07-29T10:00:00.000Z",
    adapterVersion: "1.0.0",
    ...overrides
  };
}

function approvalFor(revision: ArticleRevision): Approval {
  return {
    revisionId: revision.id,
    revisionHash: computeRevisionHash(revision),
    deviceId: "device-1",
    approvedAt: "2026-07-29T09:00:00.000Z"
  };
}

test("V1 sections produce paired content paths and their required schema types", async (t) => {
  const cases = [
    {
      section: "haberler",
      articleType: "news",
      trRoute: "haberler",
      enRoute: "news",
      schemaType: "NewsArticle"
    },
    {
      section: "analiz",
      articleType: "analysis",
      trRoute: "analiz",
      enRoute: "analysis",
      schemaType: "Article"
    },
    {
      section: "dosyalar",
      articleType: "deep_dive",
      trRoute: "dosyalar",
      enRoute: "deep-dives",
      schemaType: "Article"
    },
    {
      section: "rehberler",
      articleType: "guide",
      trRoute: "rehberler",
      enRoute: "guides",
      schemaType: "BlogPosting"
    }
  ] as const;

  for (const item of cases) {
    await t.test(`${item.section}/${item.enRoute} uses ${item.schemaType}`, () => {
      const before = fixture();
      const beforeSnapshot = structuredClone(before);
      const plan = planSiberDergiPublication(
        publication({
          section: item.section,
          articleType: item.articleType
        }),
        before,
        { now: "2026-07-29T11:00:00.000Z" }
      );

      const trPath = `src/content/articles/tr/${item.trRoute}/sifir-guven-yaklasiminda-yeni-donem.md`;
      const enPath = `src/content/articles/en/${item.enRoute}/a-new-phase-for-zero-trust.md`;
      const tr = parseSiberDergiDocument(plan.nextFixture.files[trPath] ?? "");
      const en = parseSiberDergiDocument(plan.nextFixture.files[enPath] ?? "");

      assert.deepEqual(before, beforeSnapshot, "the input fixture must stay immutable");
      assert.equal(plan.diffs.length, 2);
      assert.deepEqual(
        plan.diffs.map((diff) => [diff.path, diff.action]),
        [
          [enPath, "create"],
          [trPath, "create"]
        ]
      );
      assert.equal(tr.frontmatter.translationKey, "zero-trust-july-2026");
      assert.equal(en.frontmatter.translationKey, tr.frontmatter.translationKey);
      assert.equal(tr.frontmatter.schemaType, item.schemaType);
      assert.equal(en.frontmatter.schemaType, item.schemaType);
      assert.equal(
        tr.frontmatter.canonical,
        `https://siberdergi.net/${item.trRoute}/sifir-guven-yaklasiminda-yeni-donem/`
      );
      assert.equal(
        en.frontmatter.canonical,
        `https://siberdergi.net/en/${item.enRoute}/a-new-phase-for-zero-trust/`
      );
      assert.deepEqual(tr.frontmatter.hreflang, {
        tr: tr.frontmatter.canonical,
        en: en.frontmatter.canonical
      });
      assert.deepEqual(en.frontmatter.hreflang, tr.frontmatter.hreflang);
      assert.equal(plan.nextFixture.files["public/robots.txt"], before.files["public/robots.txt"]);
      assert.equal(plan.nextFixture.files["src/site-config.ts"], before.files["src/site-config.ts"]);
    });
  }
});

test("plans are deterministic and report create, no-op, and update without disk writes", () => {
  const emptyPlan = planSiberDergiPublication(publication(), fixture(), {
    now: "2026-07-29T11:00:00.000Z"
  });
  const repeatedPlan = planSiberDergiPublication(
    publication(),
    emptyPlan.nextFixture,
    { now: "2026-07-29T11:00:00.000Z" }
  );
  const changedPlan = planSiberDergiPublication(
    publication({
      tr: {
        ...publication().tr,
        bodyMarkdown: "## Güncelleme\n\nDoğrulanmış yeni ayrıntı."
      }
    }),
    emptyPlan.nextFixture,
    { now: "2026-07-29T11:00:00.000Z" }
  );

  assert.deepEqual(
    repeatedPlan.manifest,
    emptyPlan.manifest,
    "same approved input and clock must produce the same manifest"
  );
  assert.deepEqual(
    repeatedPlan.diffs.map((diff) => diff.action),
    ["noop", "noop"]
  );
  assert.deepEqual(
    changedPlan.diffs.map((diff) => [diff.locale, diff.action]),
    [
      ["en", "noop"],
      ["tr", "update"]
    ]
  );
  assert.match(emptyPlan.manifest.revisionHash, /^[a-f0-9]{64}$/);
  assert.ok(emptyPlan.diffs.every((diff) => isAllowedSiberDergiContentPath(diff.path)));
});

test("translationKey conflicts are rejected instead of silently breaking the TR/EN pair", () => {
  const first = planSiberDergiPublication(publication(), fixture(), {
    now: "2026-07-29T11:00:00.000Z"
  });
  const trPath =
    "src/content/articles/tr/haberler/sifir-guven-yaklasiminda-yeni-donem.md";
  const conflicting: VirtualSiteFixture = {
    files: {
      ...first.nextFixture.files,
      [trPath]: (first.nextFixture.files[trPath] ?? "").replace(
        '"translationKey": "zero-trust-july-2026"',
        '"translationKey": "another-story"'
      )
    }
  };

  assert.throws(
    () =>
      planSiberDergiPublication(publication(), conflicting, {
        now: "2026-07-29T11:00:00.000Z"
      }),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "TRANSLATION_KEY_CONFLICT"
  );
});

test("only V1 content markdown paths are allowlisted", () => {
  assert.equal(
    isAllowedSiberDergiContentPath("content/tr/haberler/ornek-haber.md"),
    false
  );
  assert.equal(
    isAllowedSiberDergiContentPath(
      "src/content/articles/tr/haberler/ornek-haber.md"
    ),
    true
  );
  assert.equal(
    isAllowedSiberDergiContentPath(
      "src/content/articles/en/deep-dives/example.md"
    ),
    true
  );
  assert.equal(
    isAllowedSiberDergiContentPath(
      "src/content/articles/tr/haberler/../../src/config.ts"
    ),
    false
  );
  assert.equal(
    isAllowedSiberDergiContentPath(
      "src/content/articles/en/news/example.mdx"
    ),
    false
  );
  assert.equal(isAllowedSiberDergiContentPath("public/news-sitemap.xml"), false);
});

test("unsafe Markdown and invalid section/type combinations fail closed", () => {
  const unsafeBodies = [
    "<script>alert('x')</script>",
    "[click](javascript:alert(1))",
    "![remote copy](https://source.example/photo.jpg)",
    "![active asset](/images/cover.svg)",
    "import Secret from './secret.ts'",
    "<Component secret={process.env.TOKEN} />"
  ];

  for (const bodyMarkdown of unsafeBodies) {
    assert.throws(
      () =>
        planSiberDergiPublication(
          publication({ tr: { ...publication().tr, bodyMarkdown } }),
          fixture(),
          { now: "2026-07-29T11:00:00.000Z" }
        ),
      (error: unknown) =>
        error instanceof SiberDergiContractError &&
        error.code === "UNSAFE_MARKDOWN"
    );
  }

  assert.throws(
    () =>
      planSiberDergiPublication(
        publication({ section: "haberler", articleType: "guide" }),
        fixture(),
        { now: "2026-07-29T11:00:00.000Z" }
      ),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "SECTION_TYPE_MISMATCH"
  );
});

test("safe Markdown keeps fenced code, internal images, and HTTPS citations intact", () => {
  const bodyMarkdown = [
    "## İnceleme",
    "",
    "```html",
    "<script>shown as inert sample code</script>",
    "```",
    "",
    "![Özgün kapak](/images/articles/revision-001/hero-wide.webp)",
    "",
    "[Birincil kaynak](https://example.com/report)"
  ].join("\n");
  const plan = planSiberDergiPublication(
    publication({
      tr: { ...publication().tr, bodyMarkdown }
    }),
    fixture(),
    { now: "2026-07-29T11:00:00.000Z" }
  );
  const document = parseSiberDergiDocument(
    plan.nextFixture.files[
      "src/content/articles/tr/haberler/sifir-guven-yaklasiminda-yeni-donem.md"
    ] ?? ""
  );

  assert.equal(document.bodyMarkdown, `${bodyMarkdown}\n`);
});

test("strict frontmatter rejects unknown fields and route metadata drift", () => {
  const plan = planSiberDergiPublication(publication(), fixture(), {
    now: "2026-07-29T11:00:00.000Z"
  });
  const path =
    "src/content/articles/tr/haberler/sifir-guven-yaklasiminda-yeni-donem.md";
  const document = plan.nextFixture.files[path] ?? "";
  const mutations = [
    document.replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1,\n  "unexpected": true,'
    ),
    document.replace(
      '"canonical": "https://siberdergi.net/haberler/sifir-guven-yaklasiminda-yeni-donem/"',
      '"canonical": "https://attacker.example/haber"'
    ),
    document.replace('"schemaType": "NewsArticle"', '"schemaType": "BlogPosting"')
  ];

  for (const mutated of mutations) {
    assert.throws(
      () => parseSiberDergiDocument(mutated),
      (error: unknown) =>
        error instanceof SiberDergiContractError &&
        error.code === "INVALID_DOCUMENT"
    );
  }
});

test("dates, verified sources, AI disclosure, and the inclusive 48-hour news window are enforced", () => {
  const atBoundary = planSiberDergiPublication(
    publication({
      publishedAt: "2026-07-27T11:00:00.000Z",
      modifiedAt: "2026-07-28T11:00:00.000Z"
    }),
    fixture(),
    { now: "2026-07-29T11:00:00.000Z" }
  );
  const afterBoundary = planSiberDergiPublication(
    publication({
      publishedAt: "2026-07-27T10:59:59.999Z",
      modifiedAt: "2026-07-28T11:00:00.000Z"
    }),
    fixture(),
    { now: "2026-07-29T11:00:00.000Z" }
  );
  const document = parseSiberDergiDocument(
    atBoundary.nextFixture.files[
      "src/content/articles/tr/haberler/sifir-guven-yaklasiminda-yeni-donem.md"
    ] ?? ""
  );

  assert.deepEqual(atBoundary.manifest.newsSitemap, {
    eligible: true,
    publicationDate: "2026-07-27T11:00:00.000Z",
    title: "Sıfır güven yaklaşımında yeni dönem",
    path: "/haberler/sifir-guven-yaklasiminda-yeni-donem/"
  });
  assert.deepEqual(afterBoundary.manifest.newsSitemap, {
    eligible: false,
    reason: "OLDER_THAN_48_HOURS"
  });
  assert.deepEqual(document.frontmatter.aiDisclosure, {
    generatedWithAi: true,
    humanReviewed: true,
    text: "AI destekli üretim; kaynaklar doğrulandı ve nihai yayın insan onayından geçti."
  });
  assert.deepEqual(document.frontmatter.sources, [
    {
      title: "Primary security report",
      url: "https://example.com/report",
      accessedAt: "2026-07-29T08:00:00.000Z"
    }
  ]);

  const invalidInputs: Array<{
    input: SiberDergiPublicationInput;
    code: string;
  }> = [
    {
      input: publication({
        approval: {
          revisionHash: "b".repeat(64),
          approvedAt: "2026-07-29T09:00:00.000Z"
        }
      }),
      code: "APPROVAL_HASH_MISMATCH"
    },
    {
      input: publication({
        modifiedAt: "2026-07-29T09:59:59.999Z"
      }),
      code: "INVALID_DATES"
    },
    {
      input: publication({
        sources: [
          {
            title: "Insecure source",
            url: "http://example.com/report",
            accessedAt: "2026-07-29T08:00:00.000Z"
          }
        ]
      }),
      code: "INVALID_SOURCE"
    }
  ];

  for (const item of invalidInputs) {
    assert.throws(
      () =>
        planSiberDergiPublication(item.input, fixture(), {
          now: "2026-07-29T11:00:00.000Z"
        }),
      (error: unknown) =>
        error instanceof SiberDergiContractError && error.code === item.code
    );
  }
});

test("approved revision materializes deterministic TR, EN, media, and manifest bytes", () => {
  const revision = articleRevision();
  const before = structuredClone(revision);
  const bundle = materializeApprovedSiberDergiBundle(
    revision,
    approvalFor(revision),
    approvedMedia,
    { now: "2026-07-29T11:00:00.000Z" }
  );
  const manifestFile = bundle.files.find(
    (file) => file.path === ".blogbot/manifests/rev-7.json"
  );

  assert.deepEqual(revision, before, "materialization must not mutate the revision");
  assert.equal(bundle.files.length, 10);
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [
      "src/content/articles/en/news/a-new-phase-for-zero-trust.md",
      "src/content/articles/tr/haberler/sifir-guven-yaklasiminda-yeni-donem.md",
      "public/sitemap.xml",
      "public/news-sitemap.xml",
      "public/robots.txt",
      "public/rss.xml",
      "public/en/rss.xml",
      "public/images/articles/rev-7/hero-square.webp",
      "public/images/articles/rev-7/hero-wide.webp",
      ".blogbot/manifests/rev-7.json"
    ]
  );
  assert.equal(typeof manifestFile?.content, "string");
  const manifest = parseSiberDergiArtifactManifest(
    manifestFile?.content as string
  );
  assert.equal(manifest.revisionHash, computeRevisionHash(revision));
  assert.equal(manifest.adapterVersion, "1.0.0");
  assert.equal(manifest.translationKey, revision.translationKey);
  assert.equal(manifest.entries.length, 9);

  for (const entry of manifest.entries) {
    const file = bundle.files.find((candidate) => candidate.path === entry.path);
    assert.ok(file, `manifest entry must have bytes: ${entry.path}`);
    const bytes =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : file.content;
    assert.equal(entry.bytes, bytes.byteLength);
    assert.equal(entry.sha256, sha256(bytes));
  }
});

test("SiberDergi materialization fails closed for a general-site-only section", () => {
  const revision = articleRevision({ section: "teknoloji", articleType: "news" });
  assert.throws(
    () => materializeApprovedSiberDergiBundle(revision, approvalFor(revision), approvedMedia, {
      now: "2026-07-29T11:00:00.000Z"
    }),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "SECTION_TYPE_MISMATCH"
  );
});

test("materialization recomputes approval hash and rejects changed approved content", () => {
  const approved = articleRevision();
  const approval = approvalFor(approved);
  const changed = articleRevision({
    tr: {
      ...approved.tr,
      bodyMarkdown: `${approved.tr.bodyMarkdown}\n\nOnaydan sonra değişti.`
    }
  });

  assert.throws(
    () =>
      materializeApprovedSiberDergiBundle(changed, approval, approvedMedia, {
        now: "2026-07-29T11:00:00.000Z"
      }),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "APPROVAL_HASH_MISMATCH"
  );
});

test("materialization rejects approval packages with unanchored legacy claims", () => {
  const current = articleRevision();
  const claim = current.claims[0]!;
  const revision = articleRevision({
    claims: [
      {
        id: claim.id,
        locale: claim.locale,
        text: claim.text,
        sourceIds: claim.sourceIds,
        status: claim.status
      }
    ]
  });

  assert.throws(
    () =>
      materializeApprovedSiberDergiBundle(
        revision,
        approvalFor(revision),
        approvedMedia,
        { now: "2026-07-29T11:00:00.000Z" }
      ),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "INVALID_CLAIM_EVIDENCE"
  );
});

test("high-risk materialization requires the second exact-hash approval", () => {
  const revision: RevisionPackageV2 = {
    ...articleRevision(),
    editorialDesk: "SiberDergi Güvenlik Masası",
    riskLevel: "HIGH",
    translationParity: {
      status: "MATCHED",
      reportHash: "1".repeat(64)
    },
    editorialPolicyHash: "2".repeat(64),
    editorialReviewReportHash: "3".repeat(64),
    targetRepository: "ucsahinn/siberdergi.net",
    targetBaseBranch: "main",
    targetBaseSha: "4".repeat(40),
    generatedFiles: [
      {
        path: "src/content/articles/tr/haberler/test.md",
        sha256: "5".repeat(64),
        size: 512
      }
    ],
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "1" }
    ]
  };

  assert.throws(
    () =>
      materializeApprovedSiberDergiBundle(
        revision,
        approvalFor(revision),
        approvedMedia,
        { now: "2026-07-29T11:00:00.000Z" }
      ),
    (error: unknown) =>
      error instanceof SiberDergiContractError &&
      error.code === "HIGH_RISK_APPROVAL_REQUIRED"
  );
});

test("materialization rejects missing, extra, duplicate, or tampered approved media", () => {
  const revision = articleRevision();
  const first = approvedMedia[0];
  const second = approvedMedia[1];
  assert.ok(first);
  assert.ok(second);
  const cases: ApprovedMediaFile[][] = [
    [first],
    [
      ...approvedMedia,
      { path: "not-approved.webp", content: new Uint8Array([9, 9, 9]) }
    ],
    [...approvedMedia, first],
    [
      {
        path: first.path,
        content: new Uint8Array([0, 0, 0])
      },
      second
    ]
  ];

  for (const media of cases) {
    assert.throws(
      () =>
        materializeApprovedSiberDergiBundle(
          revision,
          approvalFor(revision),
          media,
          { now: "2026-07-29T11:00:00.000Z" }
        ),
      (error: unknown) =>
        error instanceof SiberDergiContractError &&
        error.code === "MEDIA_BUNDLE_MISMATCH"
    );
  }
});
