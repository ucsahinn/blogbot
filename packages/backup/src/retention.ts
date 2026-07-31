export interface BackupRetentionRecord {
  id: string;
  createdAt: string;
}

export interface BackupRetentionPolicy {
  daily: number;
  weekly: number;
}

export interface BackupRetentionPlan {
  keep: Array<{
    id: string;
    reasons: Array<"daily" | "weekly">;
  }>;
  remove: Array<{
    id: string;
    reason: "superseded" | "expired";
  }>;
}

interface ParsedRecord extends BackupRetentionRecord {
  timestamp: number;
  day: string;
  week: string;
}

export function planBackupRetention(
  records: readonly BackupRetentionRecord[],
  policy: BackupRetentionPolicy
): BackupRetentionPlan {
  assertNonNegativeInteger(policy.daily, "daily");
  assertNonNegativeInteger(policy.weekly, "weekly");

  const ids = new Set<string>();
  const parsed = records.map((record): ParsedRecord => {
    if (ids.has(record.id)) {
      throw new Error(`BACKUP_RETENTION_DUPLICATE_ID: ${record.id}`);
    }
    ids.add(record.id);

    const timestamp = Date.parse(record.createdAt);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`BACKUP_RETENTION_INVALID_DATE: ${record.id}`);
    }
    const date = new Date(timestamp);
    const day = date.toISOString().slice(0, 10);
    return {
      ...record,
      timestamp,
      day,
      week: utcWeekStart(date)
    };
  });
  const newestFirst = [...parsed].sort(
    (left, right) =>
      right.timestamp - left.timestamp || left.id.localeCompare(right.id)
  );

  const dailyIds = selectNewestBucketRecords(
    newestFirst,
    policy.daily,
    (record) => record.day
  );
  const weeklyIds = selectNewestBucketRecords(
    newestFirst,
    policy.weekly,
    (record) => record.week
  );
  const keepIds = new Set([...dailyIds, ...weeklyIds]);

  return {
    keep: newestFirst
      .filter((record) => keepIds.has(record.id))
      .map((record) => {
        const reasons: Array<"daily" | "weekly"> = [];
        if (dailyIds.has(record.id)) {
          reasons.push("daily");
        }
        if (weeklyIds.has(record.id)) {
          reasons.push("weekly");
        }
        return { id: record.id, reasons };
      }),
    remove: parsed
      .filter((record) => !keepIds.has(record.id))
      .map((record) => ({
        id: record.id,
        reason: dailyIds.has(newestForDay(newestFirst, record.day)?.id ?? "")
          ? ("superseded" as const)
          : ("expired" as const)
      }))
  };
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`BACKUP_RETENTION_INVALID_POLICY: ${name}`);
  }
}

function selectNewestBucketRecords(
  records: readonly ParsedRecord[],
  limit: number,
  bucketFor: (record: ParsedRecord) => string
): Set<string> {
  const selected = new Set<string>();
  const buckets = new Set<string>();
  for (const record of records) {
    const bucket = bucketFor(record);
    if (buckets.has(bucket)) {
      continue;
    }
    if (buckets.size >= limit) {
      break;
    }
    buckets.add(bucket);
    selected.add(record.id);
  }
  return selected;
}

function newestForDay(
  records: readonly ParsedRecord[],
  day: string
): ParsedRecord | undefined {
  return records.find((record) => record.day === day);
}

function utcWeekStart(date: Date): string {
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}
