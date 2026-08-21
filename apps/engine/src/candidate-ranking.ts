export interface CandidateRankingEvidence {
  sourceId: string;
  policyApproved: boolean;
  publishedAt?: string;
  defaultSection?: string;
  defaultArticleType?: string;
}

export interface CandidateRankingInput {
  id: string;
  title: string;
  summary: string;
  discoveredAt: string;
  evidence: CandidateRankingEvidence[];
}

export interface RankedCandidateStory extends CandidateRankingInput {
  sourceSufficiencyScore: number;
  freshnessScore: number;
  originalityScore: number;
  topicFitScore: number;
  rankingScore: number;
  scoreReasons: string[];
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MISSING_FRESHNESS_SCORE = 10;
const MISSING_TOPIC_FIT_SCORE = 20;
const NO_COMPARISON_ORIGINALITY_SCORE = 50;

function boundedReason(reason: string): string {
  return reason.slice(0, 180);
}

function sourceSufficiency(evidence: readonly CandidateRankingEvidence[]): {
  score: number;
  reason: string;
} {
  const approvedSources = new Set(
    evidence
      .filter((item) => item.policyApproved)
      .map((item) => item.sourceId)
  );
  if (approvedSources.size === 0) {
    return {
      score: 0,
      reason: "Kaynak yeterliliği: güven ve kullanım hakkı onaylı kaynak yok."
    };
  }
  if (approvedSources.size === 1) {
    return {
      score: 45,
      reason: "Kaynak yeterliliği: tek onaylı kaynak var; bağımsız doğrulama gerekiyor."
    };
  }
  if (approvedSources.size === 2) {
    return {
      score: 80,
      reason: "Kaynak yeterliliği: iki ayrı onaylı kaynak olayı doğruluyor."
    };
  }
  return {
    score: 100,
    reason: `Kaynak yeterliliği: ${approvedSources.size} ayrı onaylı kaynak olayı doğruluyor.`
  };
}

function freshness(evidence: readonly CandidateRankingEvidence[], nowMs: number): {
  score: number;
  reason: string;
} {
  const publicationDates = evidence
    .map((item) => item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN)
    .filter((value) => Number.isFinite(value) && value <= nowMs + (5 * 60 * 1_000));
  if (publicationDates.length === 0) {
    return {
      score: MISSING_FRESHNESS_SCORE,
      reason: "Güncellik: Yayın tarihi yok; düşük taban puanı kullanıldı."
    };
  }

  const latestPublication = Math.max(...publicationDates);
  const ageMs = Math.max(0, nowMs - latestPublication);
  if (ageMs <= DAY_MS) return { score: 100, reason: "Güncellik: son 24 saatte yayımlandı." };
  if (ageMs <= 3 * DAY_MS) return { score: 85, reason: "Güncellik: son 3 günde yayımlandı." };
  if (ageMs <= 7 * DAY_MS) return { score: 70, reason: "Güncellik: son 7 günde yayımlandı." };
  if (ageMs <= 30 * DAY_MS) return { score: 45, reason: "Güncellik: son 30 günde yayımlandı." };
  if (ageMs <= 90 * DAY_MS) return { score: 25, reason: "Güncellik: yayın tarihi 30 günden eski." };
  return { score: MISSING_FRESHNESS_SCORE, reason: "Güncellik: yayın tarihi 90 günden eski." };
}

function normalizedTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("tr-TR")
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function tokenSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function maximumStorySimilarity(
  story: CandidateRankingInput,
  allStories: readonly CandidateRankingInput[]
): number | null {
  const otherStories = allStories.filter((candidate) => candidate.id !== story.id);
  if (otherStories.length === 0) return null;
  const titleTokens = normalizedTokens(story.title);
  const summaryTokens = normalizedTokens(story.summary);
  return Math.max(
    ...otherStories.map((candidate) => Math.max(
      tokenSimilarity(titleTokens, normalizedTokens(candidate.title)),
      tokenSimilarity(summaryTokens, normalizedTokens(candidate.summary))
    ))
  );
}

function originality(story: CandidateRankingInput, allStories: readonly CandidateRankingInput[]): {
  score: number;
  reason: string;
} {
  const similarity = maximumStorySimilarity(story, allStories);
  if (similarity === null) {
    return {
      score: NO_COMPARISON_ORIGINALITY_SCORE,
      reason: "Özgünlük: karşılaştırılabilir başka olay kümesi yok; nötr puan kullanıldı."
    };
  }
  const similarityPercent = Math.round(similarity * 100);
  return {
    score: Math.max(0, 100 - similarityPercent),
    reason: `Özgünlük: ayrı olay kümeleri içindeki en yüksek başlık/özet benzerliği %${similarityPercent}.`
  };
}

function topicFit(evidence: readonly CandidateRankingEvidence[]): {
  score: number;
  reason: string;
} {
  const mappingBySource = new Map<string, string>();
  let hasPartialMapping = false;
  for (const item of evidence) {
    if (item.defaultSection || item.defaultArticleType) hasPartialMapping = true;
    if (!item.defaultSection || !item.defaultArticleType || mappingBySource.has(item.sourceId)) continue;
    mappingBySource.set(item.sourceId, `${item.defaultSection}\u0000${item.defaultArticleType}`);
  }
  if (mappingBySource.size === 0) {
    return hasPartialMapping
      ? {
          score: 35,
          reason: "Konu uyumu: kaynak eşlemesi eksik; bölüm ve içerik türü birlikte tanımlı değil."
        }
      : {
          score: MISSING_TOPIC_FIT_SCORE,
          reason: "Konu uyumu: kaynaklarda konu eşlemesi yok; düşük taban puanı kullanıldı."
        };
  }
  if (mappingBySource.size === 1) {
    return {
      score: 65,
      reason: "Konu uyumu: tek kaynakta açık bölüm ve içerik türü eşlemesi var."
    };
  }

  const counts = new Map<string, number>();
  for (const mapping of mappingBySource.values()) {
    counts.set(mapping, (counts.get(mapping) ?? 0) + 1);
  }
  const agreementCount = Math.max(...counts.values());
  if (agreementCount === mappingBySource.size) {
    return {
      score: 100,
      reason: `Konu uyumu: ${mappingBySource.size} kaynak aynı bölüm ve içerik türünde uzlaşıyor.`
    };
  }
  if (agreementCount > mappingBySource.size / 2) {
    return {
      score: 75,
      reason: `Konu uyumu: ${agreementCount}/${mappingBySource.size} kaynak aynı yönlendirmede çoğunluk sağlıyor.`
    };
  }
  return {
    score: 40,
    reason: `Konu uyumu: ${mappingBySource.size} kaynağın yönlendirmeleri çatışıyor.`
  };
}

function discoveryTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Score and sort already-deduplicated story clusters. Evidence from the same
 * source never counts as independent corroboration, and missing measurements
 * receive explicit low or neutral scores instead of optimistic defaults.
 */
export function rankCandidateStories(
  stories: readonly CandidateRankingInput[],
  nowMs = Date.now()
): RankedCandidateStory[] {
  return stories
    .map((story): RankedCandidateStory => {
      const sufficiency = sourceSufficiency(story.evidence);
      const recentness = freshness(story.evidence, nowMs);
      const distinctness = originality(story, stories);
      const routing = topicFit(story.evidence);
      return {
        ...story,
        sourceSufficiencyScore: sufficiency.score,
        freshnessScore: recentness.score,
        originalityScore: distinctness.score,
        topicFitScore: routing.score,
        rankingScore: Math.round(
          (sufficiency.score + recentness.score + distinctness.score + routing.score) / 4
        ),
        scoreReasons: [
          boundedReason(sufficiency.reason),
          boundedReason(recentness.reason),
          boundedReason(distinctness.reason),
          boundedReason(routing.reason)
        ]
      };
    })
    .sort((left, right) =>
      right.rankingScore - left.rankingScore
      || discoveryTime(right.discoveredAt) - discoveryTime(left.discoveredAt)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}
