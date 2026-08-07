import assert from "node:assert/strict";
import test from "node:test";

import {
  PREFERRED_PUBLISHING_TIMES,
  createWeeklySlotIds,
  resolveScheduleTime,
  scheduleTimeChoice,
  weeklySlotDay
} from "../../apps/desktop/src/schedule-options.ts";

test("weekly schedule offers a compact set of editorial publishing times", () => {
  assert.deepEqual(PREFERRED_PUBLISHING_TIMES, ["08:00", "09:30", "11:00", "13:30", "16:00", "18:30", "20:00"]);
});

test("weekly schedule keeps an existing non-preset time as a custom selection", () => {
  assert.equal(scheduleTimeChoice("17:15"), "CUSTOM");
  assert.equal(scheduleTimeChoice("09:30"), "09:30");
});

test("weekly schedule accepts a valid custom time and rejects malformed values", () => {
  assert.equal(resolveScheduleTime("CUSTOM", "17:15"), "17:15");
  assert.equal(resolveScheduleTime("18:30", ""), "18:30");
  assert.throws(() => resolveScheduleTime("CUSTOM", "25:00"), /geçerli bir saat/u);
});

test("weekly schedule permits up to five independently configurable slots per day", () => {
  assert.deepEqual(createWeeklySlotIds("mon"), ["slot-mon-1", "slot-mon-2", "slot-mon-3", "slot-mon-4", "slot-mon-5"]);
  assert.equal(weeklySlotDay("slot-mon-3"), "mon");
  assert.equal(weeklySlotDay("slot-sun-5"), "sun");
  assert.equal(weeklySlotDay("slot-mon-6"), null);
});
