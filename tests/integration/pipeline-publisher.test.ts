import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  computeRevisionHash,
  type Approval,
  type ArticleRevision
} from "../../packages/editorial/src/revision.ts";
import {
  PublisherGuardError,
  assertAllowedContentPath,
  createPublicationEffectKey,
  reconcileApprovedPublication,
  type DeployIntent,
  type PublicationEffectsPort,
  type PublicationFile,
  type PullRequestState
} from "../../apps/publisher/src/publication.ts";
import {
  buildPublisherDryRunPlan,
  ConnectorConfigError,
  validatePublisherConnectorConfig,
  type PublisherConnectorConfigInput
} from "../../apps/publisher/src/publication.ts";

const approvedSha = "a".repeat(40);
const mergeSha = "b".repeat(40);

const approvedMedia = [
  {
    path: "hero-wide.webp",
    content: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
  },
  {
    path: "hero-square.webp",
    content: new Uint8Array([82, 73, 70, 70, 5, 6, 7, 8])
  }
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const revision: ArticleRevision = {
  id: "rev-7",
  translationKey: "example-news",
  state: "APPROVED",
  tr: {
    title: "Örnek haber",
    slug: "ornek-haber",
    description: "Doğrulanmış kaynaklara dayalı örnek haber.",
    bodyMarkdown: "## Özet\n\nDoğrulanmış özgün haber metni.",
    heroImageAlt: "Özgün haber kapağı"
  },
  en: {
    title: "Example news",
    slug: "example-news",
    description: "An example report based on verified sources.",
    bodyMarkdown: "## Summary\n\nOriginal localized report.",
    heroImageAlt: "Original news cover"
  },
  section: "haberler",
  articleType: "news",
  author: "Example Editorial",
  tags: ["güvenlik"],
  claims: [
    {
      id: "claim-1",
      locale: "both",
      text: "Örnek iddia doğrulandı.",
      sourceIds: ["source-1"],
      status: "VERIFIED",
      claimKey: "claim.example.verified",
      trText: "Örnek iddia doğrulandı.",
      enText: "The example claim was verified.",
      evidenceAnchors: [
        {
          sourceId: "source-1",
          quoteHash: "a".repeat(64),
          start: 0,
          end: 29
        }
      ]
    }
  ],
  sources: [
    {
      id: "source-1",
      url: "https://example.com/report",
      title: "Primary report",
      fetchedAt: "2026-07-29T08:00:00.000Z",
      contentHash: "sha256:source"
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
  adapterVersion: "1.0.0"
};
const approval: Approval = {
  revisionId: revision.id,
  revisionHash: computeRevisionHash(revision),
  deviceId: "device-1",
  approvedAt: "2026-07-29T09:00:00.000Z"
};
const approvedHash = approval.revisionHash;
const generic = genericBundle();
const files: PublicationFile[] = [...generic.files];

function command(overrides: Partial<Parameters<typeof reconcileApprovedPublication>[0]> = {}) {
  return {
    articleId: "article-7",
    revisionId: "rev-7",
    approvedRevisionHash: approvedHash,
    currentRevisionHash: approvedHash,
    targetRepository: "owner/site",
    baseBranch: "main",
    approvedBaseSha: "c".repeat(40),
    currentBaseSha: "c".repeat(40),
    approvedHeadSha: approvedSha,
    currentHeadSha: approvedSha,
    files,
    bundlePolicy: generic.bundlePolicy,
    ...overrides
  };
}

function commandWithoutBundlePolicy(): Omit<Parameters<typeof reconcileApprovedPublication>[0], "bundlePolicy"> {
  const { bundlePolicy: _bundlePolicy, ...withoutBundlePolicy } = command();
  return withoutBundlePolicy;
}

function genericBundle() {
  const content = (value: string) => `${value}\n`;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const entries = [
    { path: "content/tr/story.md", content: content("tr") },
    { path: "content/en/story.md", content: content("en") },
    { path: "assets/story.webp", content: content("image") }
  ];
  const manifest = JSON.stringify({
    version: 1,
    revisionId: "rev-7",
    revisionHash: approvedHash,
    adapterVersion: "astro@1",
    generatedAt: "2026-07-29T11:00:00.000Z",
    entries: entries.map((entry) => ({ path: entry.path, sha256: digest(entry.content), bytes: Buffer.byteLength(entry.content) }))
  });
  return {
    files: [...entries.map(({ path, content }) => ({ path, content })), { path: ".blogbot/manifests/rev-7.json", content: manifest }],
    bundlePolicy: {
      adapterId: "astro",
      manifestPath: ".blogbot/manifests/rev-7.json",
      allowedPathPrefixes: ["content/", "assets/", ".blogbot/manifests/"],
      requiredLocalePrefixes: ["content/tr/", "content/en/"],
      requiredMediaPrefix: "assets/"
    }
  } as const;
}

class StrictMemoryEffects implements PublicationEffectsPort {
  readonly pullRequests = new Map<string, PullRequestState>();
  readonly deployIntents = new Map<string, DeployIntent>();
  readonly createPullRequestCalls: string[] = [];
  readonly mergePullRequestCalls: string[] = [];
  readonly createDeployIntentCalls: string[] = [];

  async findPullRequest(key: string) {
    return this.pullRequests.get(key) ?? null;
  }

  async createPullRequest(input: {
    key: string;
    targetRepository: string;
    baseBranch: string;
    expectedBaseSha: string;
    expectedHeadSha: string;
    files: readonly PublicationFile[];
  }) {
    if (this.pullRequests.has(input.key)) throw new Error("duplicate PR effect");
    this.createPullRequestCalls.push(input.key);
    const state: PullRequestState = {
      number: 17,
      headSha: input.expectedHeadSha,
      merged: false,
      requiredChecks: "PASSED"
    };
    this.pullRequests.set(input.key, state);
    return state;
  }

  async mergePullRequest(input: {
    key: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }) {
    this.mergePullRequestCalls.push(input.key);
    const entry = [...this.pullRequests.entries()].find(
      ([, state]) => state.number === input.pullRequestNumber
    );
    if (!entry) throw new Error("PR missing");
    if (entry[1].headSha !== input.expectedHeadSha) throw new Error("head changed");
    const state: PullRequestState = {
      ...entry[1],
      merged: true,
      mergeSha
    };
    this.pullRequests.set(entry[0], state);
    return state;
  }

  async findDeployIntent(key: string) {
    return this.deployIntents.get(key) ?? null;
  }

  async createDeployIntent(input: {
    key: string;
    revisionId: string;
    mergeSha: string;
  }) {
    if (this.deployIntents.has(input.key)) {
      throw new Error("duplicate deploy intent");
    }
    this.createDeployIntentCalls.push(input.key);
    const intent: DeployIntent = {
      key: input.key,
      revisionId: input.revisionId,
      mergeSha: input.mergeSha
    };
    this.deployIntents.set(input.key, intent);
    return intent;
  }
}

test("accepts only selected adapter artifact paths and the Blogbot manifest", async () => {
  const effects = new StrictMemoryEffects();
  const result = await reconcileApprovedPublication(command(), effects);

  assert.equal(result.state, "READY_TO_DEPLOY");
  assert.equal(result.pullRequest.number, 17);
  assert.equal(result.pullRequest.merged, true);
  assert.equal(result.deployIntent?.mergeSha, mergeSha);
});

test("rejects an empty publication bundle before creating effects", async () => {
  const effects = new StrictMemoryEffects();

  await assert.rejects(
    reconcileApprovedPublication(command({ files: [] }), effects),
    (error: unknown) =>
      error instanceof PublisherGuardError && error.code === "BUNDLE_EMPTY"
  );
  assert.equal(effects.createPullRequestCalls.length, 0);
});

test("rejects missing TR, EN, or media files before creating effects", async () => {
  for (const prefix of [
    "content/tr/",
    "content/en/",
    "assets/"
  ]) {
    const effects = new StrictMemoryEffects();
    await assert.rejects(
      reconcileApprovedPublication(
        command({ files: files.filter((file) => !file.path.startsWith(prefix)) }),
        effects
      ),
      (error: unknown) =>
        error instanceof PublisherGuardError &&
        error.code === "BUNDLE_FILE_SET_MISMATCH"
    );
    assert.equal(effects.createPullRequestCalls.length, 0);
  }
});

test("rejects extra and duplicate publication paths before creating effects", async () => {
  const extra: PublicationFile = {
    path: "content/tr/extra.md",
    content: "extra"
  };
  const duplicate = files[0];
  assert.ok(duplicate);

  for (const invalidFiles of [[...files, extra], [...files, duplicate]]) {
    const effects = new StrictMemoryEffects();
    await assert.rejects(
      reconcileApprovedPublication(command({ files: invalidFiles }), effects),
      (error: unknown) =>
        error instanceof PublisherGuardError &&
        (error.code === "BUNDLE_FILE_SET_MISMATCH" ||
          error.code === "BUNDLE_DUPLICATE_PATH")
    );
    assert.equal(effects.createPullRequestCalls.length, 0);
  }
});

test("rejects tampered content and manifest bytes before creating effects", async () => {
  const mediaIndex = files.findIndex((file) =>
    file.path === "assets/story.webp"
  );
  const manifestIndex = files.findIndex((file) =>
    file.path.startsWith(".blogbot/manifests/")
  );
  assert.notEqual(mediaIndex, -1);
  assert.notEqual(manifestIndex, -1);

  const tamperedMedia = files.map((file, index) =>
    index === mediaIndex
      ? { ...file, content: new Uint8Array([0, 0, 0]) }
      : file
  );
  const tamperedManifest = files.map((file, index) =>
    index === manifestIndex
      ? {
          ...file,
          content: (file.content as string).replace(
            approvedHash,
            "d".repeat(64)
          )
        }
      : file
  );

  for (const invalidFiles of [tamperedMedia, tamperedManifest]) {
    const effects = new StrictMemoryEffects();
    await assert.rejects(
      reconcileApprovedPublication(command({ files: invalidFiles }), effects),
      (error: unknown) =>
        error instanceof PublisherGuardError &&
        (error.code === "BUNDLE_FILE_TAMPERED" ||
          error.code === "BUNDLE_MANIFEST_MISMATCH")
    );
    assert.equal(effects.createPullRequestCalls.length, 0);
  }
});

test("accepts selected adapter paths and rejects paths outside its policy", () => {
  assert.doesNotThrow(() =>
    assertAllowedContentPath(
      "content/en/deep-dives/identity-security.md",
      generic.bundlePolicy
    )
  );
  assert.throws(() =>
    assertAllowedContentPath(
      "config/identity-security.md",
      generic.bundlePolicy
    )
  );
});

test("rejects traversal and repository-control paths before creating effects", async () => {
  for (const path of [
    "../outside.md",
    "content/tr/../../config.ts",
    ".github/workflows/deploy.yml",
    "astro.config.mjs"
  ]) {
    assert.throws(
      () => assertAllowedContentPath(path, generic.bundlePolicy),
      (error: unknown) =>
        error instanceof PublisherGuardError &&
        error.code === "CONTENT_PATH_FORBIDDEN"
    );
  }
});

test("rejects changed revision hashes and PR head SHAs before creating effects", async () => {
  for (const mismatch of [
    { currentRevisionHash: "d".repeat(64) },
    { currentHeadSha: "e".repeat(40) }
  ]) {
    const effects = new StrictMemoryEffects();
    await assert.rejects(
      reconcileApprovedPublication(command(mismatch), effects),
      (error: unknown) =>
        error instanceof PublisherGuardError &&
        (error.code === "APPROVAL_HASH_MISMATCH" ||
          error.code === "HEAD_SHA_MISMATCH")
    );
    assert.equal(effects.createPullRequestCalls.length, 0);
  }
});

test("base SHA drift invalidates publication before creating effects", async () => {
  const effects = new StrictMemoryEffects();
  await assert.rejects(
    reconcileApprovedPublication(
      command({ currentBaseSha: "d".repeat(40) }),
      effects
    ),
    (error: unknown) =>
      error instanceof PublisherGuardError &&
      error.code === "BASE_SHA_MISMATCH"
  );
  assert.equal(effects.createPullRequestCalls.length, 0);
});

test("pending required checks wait without merge or deploy effects", async () => {
  const effects = new StrictMemoryEffects();
  const pullRequestKey = createPublicationEffectKey(
    "pull-request",
    "article-7",
    "rev-7",
    approvedHash,
    "owner/site",
    "main",
    "c".repeat(40)
  );
  effects.pullRequests.set(pullRequestKey, {
    number: 17,
    headSha: approvedSha,
    merged: false,
    requiredChecks: "PENDING"
  });

  const result = await reconcileApprovedPublication(command(), effects);

  assert.equal(result.state, "WAITING_FOR_CHECKS");
  assert.equal(result.deployIntent, null);
  assert.deepEqual(effects.mergePullRequestCalls, []);
  assert.deepEqual(effects.createDeployIntentCalls, []);
});

test("failed required checks block merge and deploy effects", async () => {
  const effects = new StrictMemoryEffects();
  const pullRequestKey = createPublicationEffectKey(
    "pull-request",
    "article-7",
    "rev-7",
    approvedHash,
    "owner/site",
    "main",
    "c".repeat(40)
  );
  effects.pullRequests.set(pullRequestKey, {
    number: 17,
    headSha: approvedSha,
    merged: false,
    requiredChecks: "FAILED"
  });

  await assert.rejects(
    reconcileApprovedPublication(command(), effects),
    (error: unknown) =>
      error instanceof PublisherGuardError &&
      error.code === "REQUIRED_CHECKS_FAILED"
  );
  assert.deepEqual(effects.mergePullRequestCalls, []);
  assert.deepEqual(effects.createDeployIntentCalls, []);
});

test("rejects a manifest bound to a different revision id", async () => {
  const manifestPath = ".blogbot/manifests/rev-7.json";
  const manifestFile = files.find((file) => file.path === manifestPath);
  assert.equal(typeof manifestFile?.content, "string");
  const tamperedManifest = JSON.stringify({
    ...JSON.parse(manifestFile?.content as string),
    revisionId: "rev-other"
  }, null, 2) + "\n";
  const tamperedFiles = files.map((file) =>
    file.path === manifestPath ? { ...file, content: tamperedManifest } : file
  );

  await assert.rejects(
    () => reconcileApprovedPublication(command({ files: tamperedFiles }), new StrictMemoryEffects()),
    (error: unknown) =>
      error instanceof PublisherGuardError &&
      error.code === "BUNDLE_MANIFEST_MISMATCH"
  );
});

test("uses stable effect keys and reconciles retries without duplicate PR, merge, or deploy intent", async () => {
  const effects = new StrictMemoryEffects();
  const first = await reconcileApprovedPublication(command(), effects);
  const retry = await reconcileApprovedPublication(command(), effects);

  assert.equal(first.pullRequestKey, retry.pullRequestKey);
  assert.equal(first.mergeKey, retry.mergeKey);
  assert.equal(first.deployKey, retry.deployKey);
  assert.deepEqual(effects.createPullRequestCalls, [first.pullRequestKey]);
  assert.deepEqual(effects.mergePullRequestCalls, [first.mergeKey]);
  assert.deepEqual(effects.createDeployIntentCalls, [first.deployKey]);
});

test("changes every publication effect key when the approved revision changes", () => {
  for (const effect of ["pull-request", "merge", "deploy"] as const) {
    assert.notEqual(
      createPublicationEffectKey(effect, "article-7", "rev-7", approvedHash),
      createPublicationEffectKey(effect, "article-7", "rev-8", "d".repeat(64))
    );
    assert.equal(
      createPublicationEffectKey(effect, "article-7", "rev-7", approvedHash),
      createPublicationEffectKey(effect, "article-7", "rev-7", approvedHash)
    );
  }
  assert.notEqual(
    createPublicationEffectKey(
      "pull-request",
      "article-7",
      "rev-7",
      approvedHash,
      "owner/site",
      "main",
      "c".repeat(40)
    ),
    createPublicationEffectKey(
      "pull-request",
      "article-7",
      "rev-7",
      approvedHash,
      "ucsahinn/other-site",
      "main",
      "c".repeat(40)
    )
  );
});

const connectorConfig: PublisherConnectorConfigInput = {
  github: { repository: "owner/site", baseBranch: "main" },
  site: { siteOrigin: "https://example.org", contentRoot: "/srv/site", adapterId: "astro" }
};

test("validates user-entered generic connector config without accepting credentials", () => {
  assert.deepEqual(validatePublisherConnectorConfig(connectorConfig), connectorConfig);
  assert.throws(
    () => validatePublisherConnectorConfig({ ...connectorConfig, github: { ...connectorConfig.github, token: ["not", "accepted"].join("-") } } as never),
    (error: unknown) => error instanceof ConnectorConfigError && error.code === "CREDENTIALS_NOT_ALLOWED"
  );
  assert.throws(
    () => validatePublisherConnectorConfig({ ...connectorConfig, github: { repository: "bad", baseBranch: "main" } }),
    (error: unknown) => error instanceof ConnectorConfigError && error.code === "INVALID_REPOSITORY"
  );
});

test("requires a generic site connector instead of accepting legacy connector fields", () => {
  assert.throws(
    () => validatePublisherConnectorConfig({
      github: { repository: "owner/site", baseBranch: "main" },
      legacySite: { siteOrigin: "https://legacy.example", contentRoot: "/srv/site" },
      legacyHosting: { host: "example.org", releaseRoot: "/var/www/site" }
    } as never),
    (error: unknown) => error instanceof ConnectorConfigError && error.code === "INVALID_CONFIG"
  );
});

test("publication reconciliation fails closed when the bundle policy is missing", async () => {
  await assert.rejects(
    reconcileApprovedPublication(commandWithoutBundlePolicy() as Parameters<typeof reconcileApprovedPublication>[0], new StrictMemoryEffects()),
    (error: unknown) => error instanceof PublisherGuardError && error.code === "BUNDLE_POLICY_REQUIRED"
  );
});

test("builds a deterministic no-write plan for a generic site and GitHub", () => {
  const plan = buildPublisherDryRunPlan({
    command: command(),
    connectors: connectorConfig,
    now: "2026-07-29T11:00:00.000Z"
  });
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.credentialsRequired, false);
  assert.deepEqual(plan.steps.map((step) => [step.connector, step.action]), [
    ["site", "validate-bundle"],
    ["github", "create-pull-request"],
    ["github", "merge-after-checks"]
  ]);
  assert.equal(plan.steps.at(-1)?.writes, false);
  assert.equal(plan.target.repository, "owner/site");
});

test("accepts a user-selected generic site", () => {
  const bundle = genericBundle();
  const plan = buildPublisherDryRunPlan({
    command: command(bundle),
    connectors: {
      github: { repository: "owner/site", baseBranch: "main" },
      site: { siteOrigin: "https://example.org", contentRoot: "/srv/site", adapterId: "astro" }
    },
    now: "2026-07-30T12:00:00.000Z"
  });
  assert.equal(plan.target.siteOrigin, "https://example.org");
  assert.equal(plan.target.host, undefined);
  assert.deepEqual(plan.steps.map((step) => step.connector), ["site", "github", "github"]);
});

test("generic dry-run fails closed when the adapter bundle policy is missing", () => {
  assert.throws(() => buildPublisherDryRunPlan({
    command: commandWithoutBundlePolicy() as Parameters<typeof reconcileApprovedPublication>[0],
    connectors: {
      github: { repository: "owner/site", baseBranch: "main" },
      site: { siteOrigin: "https://example.org", contentRoot: "/srv/site", adapterId: "astro" }
    },
    now: "2026-07-30T12:00:00.000Z"
  }), (error: unknown) => error instanceof PublisherGuardError && error.code === "BUNDLE_POLICY_REQUIRED");
});

test("validates an adapter-neutral bundle using the selected site's path policy", async () => {
  const bundle = genericBundle();
  const result = await reconcileApprovedPublication(command({
    files: bundle.files,
    bundlePolicy: bundle.bundlePolicy
  }), new StrictMemoryEffects());
  assert.equal(result.state, "READY_TO_DEPLOY");
  assert.throws(() => assertAllowedContentPath("content/../secrets.env", {
    adapterId: "astro",
    manifestPath: ".blogbot/manifests/rev-7.json",
    allowedPathPrefixes: ["content/", "assets/", ".blogbot/manifests/"]
  }), (error: unknown) => error instanceof PublisherGuardError && error.code === "CONTENT_PATH_FORBIDDEN");
  for (const unsafe of ["content//story.md", "content/", "content", "content/./story.md"]) {
    assert.throws(() => assertAllowedContentPath(unsafe, {
      adapterId: "astro",
      manifestPath: ".blogbot/manifests/rev-7.json",
      allowedPathPrefixes: ["content/", "assets/", ".blogbot/manifests/"]
    }), (error: unknown) => error instanceof PublisherGuardError && error.code === "CONTENT_PATH_FORBIDDEN", unsafe);
  }
});

test("generic publisher dry-run validates the selected adapter bundle policy", () => {
  const content = (value: string) => `${value}\n`;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const entries = [
    { path: "content/tr/story.md", content: content("tr") },
    { path: "content/en/story.md", content: content("en") },
    { path: "assets/story.webp", content: content("image") }
  ];
  const manifestPath = ".blogbot/manifests/rev-7.json";
  const manifest = JSON.stringify({
    version: 1,
    revisionId: "rev-7",
    revisionHash: approvedHash,
    adapterVersion: "astro@1",
    generatedAt: "2026-07-29T11:00:00.000Z",
    entries: entries.map((entry) => ({ path: entry.path, sha256: digest(entry.content), bytes: Buffer.byteLength(entry.content) }))
  });
  const genericFiles = [
    ...entries.map(({ path, content }) => ({ path, content })),
    { path: manifestPath, content: manifest }
  ];
  const plan = buildPublisherDryRunPlan({
    command: command({
      files: genericFiles,
      bundlePolicy: {
        adapterId: "astro",
        manifestPath,
        allowedPathPrefixes: ["content/", "assets/", ".blogbot/manifests/"],
        requiredLocalePrefixes: ["content/tr/", "content/en/"],
        requiredMediaPrefix: "assets/"
      }
    }),
    connectors: {
      github: { repository: "owner/site", baseBranch: "main" },
      site: { siteOrigin: "https://example.org", contentRoot: "/srv/site", adapterId: "astro" }
    },
    now: "2026-07-30T12:00:00.000Z"
  });
  assert.equal(plan.target.siteOrigin, "https://example.org");
  assert.deepEqual(plan.steps.map((step) => step.connector), ["site", "github", "github"]);
});
