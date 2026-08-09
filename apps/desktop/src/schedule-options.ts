export const PREFERRED_PUBLISHING_TIMES = [
  "08:00",
  "09:30",
  "11:00",
  "13:30",
  "16:00",
  "18:30",
  "20:00"
] as const;

export const WEEKLY_SLOT_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const MAX_SLOTS_PER_DAY = 5;

export type WeeklySlotDay = (typeof WEEKLY_SLOT_DAYS)[number];

export interface SeoSlotCandidate {
  id: string;
  articleId: string | null;
}

export interface SeoSlotRecommendation {
  slotId: string;
  time: string;
  enabled: true;
}

export type ScheduleTimeChoice = (typeof PREFERRED_PUBLISHING_TIMES)[number] | "CUSTOM";

const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function createWeeklySlotIds(day: WeeklySlotDay): string[] {
  return Array.from({ length: MAX_SLOTS_PER_DAY }, (_, index) => `slot-${day}-${index + 1}`);
}

export function weeklySlotDay(slotId: string): WeeklySlotDay | null {
  const match = /^slot-(mon|tue|wed|thu|fri|sat|sun)-[1-5]$/u.exec(slotId);
  return match ? match[1] as WeeklySlotDay : null;
}

export function scheduleTimeChoice(time: string): ScheduleTimeChoice {
  return PREFERRED_PUBLISHING_TIMES.includes(time as (typeof PREFERRED_PUBLISHING_TIMES)[number])
    ? time as (typeof PREFERRED_PUBLISHING_TIMES)[number]
    : "CUSTOM";
}

export function resolveScheduleTime(choice: ScheduleTimeChoice, customTime: string): string {
  const value = choice === "CUSTOM" ? customTime : choice;
  if (!scheduleTimePattern.test(value)) {
    throw new Error("Özel saat, 00:00 ile 23:59 arasında geçerli bir saat olmalıdır.");
  }
  return value;
}

/** Three spaced editorial windows; this changes only empty calendar slots. */
export function recommendBalancedSeoSlots(
  slots: readonly SeoSlotCandidate[]
): SeoSlotRecommendation[] {
  const cadence = [
    { day: "tue", time: "10:30" },
    { day: "thu", time: "14:00" },
    { day: "sat", time: "11:00" }
  ] as const;
  return cadence.flatMap(({ day, time }) => {
    const slot = slots.find((candidate) => weeklySlotDay(candidate.id) === day && candidate.articleId === null);
    return slot ? [{ slotId: slot.id, time, enabled: true as const }] : [];
  });
}
