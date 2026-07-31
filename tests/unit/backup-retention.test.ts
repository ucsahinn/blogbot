import assert from "node:assert/strict";
import test from "node:test";

import {
  planBackupRetention
} from "../../packages/backup/src/index.ts";

test("retention keeps the newest backup in daily and weekly buckets", () => {
  const plan = planBackupRetention(
    [
      { id: "same-day-old", createdAt: "2026-07-30T08:00:00.000Z" },
      { id: "day-0", createdAt: "2026-07-30T12:00:00.000Z" },
      { id: "day-1", createdAt: "2026-07-29T12:00:00.000Z" },
      { id: "day-2", createdAt: "2026-07-28T12:00:00.000Z" },
      { id: "week-1", createdAt: "2026-07-20T12:00:00.000Z" },
      { id: "week-2", createdAt: "2026-07-13T12:00:00.000Z" },
      { id: "expired", createdAt: "2026-07-06T12:00:00.000Z" }
    ],
    { daily: 2, weekly: 2 }
  );

  assert.deepEqual(
    plan.keep.map(({ id, reasons }) => ({ id, reasons })),
    [
      { id: "day-0", reasons: ["daily", "weekly"] },
      { id: "day-1", reasons: ["daily"] },
      { id: "week-1", reasons: ["weekly"] }
    ]
  );
  assert.deepEqual(
    plan.remove.map(({ id, reason }) => ({ id, reason })),
    [
      { id: "same-day-old", reason: "superseded" },
      { id: "day-2", reason: "expired" },
      { id: "week-2", reason: "expired" },
      { id: "expired", reason: "expired" }
    ]
  );
});

test("retention rejects duplicate ids and invalid dates", () => {
  assert.throws(
    () =>
      planBackupRetention(
        [
          { id: "duplicate", createdAt: "2026-07-30T12:00:00.000Z" },
          { id: "duplicate", createdAt: "2026-07-29T12:00:00.000Z" }
        ],
        { daily: 14, weekly: 8 }
      ),
    /BACKUP_RETENTION_DUPLICATE_ID/
  );
  assert.throws(
    () =>
      planBackupRetention(
        [{ id: "invalid", createdAt: "not-a-date" }],
        { daily: 14, weekly: 8 }
      ),
    /BACKUP_RETENTION_INVALID_DATE/
  );
});
