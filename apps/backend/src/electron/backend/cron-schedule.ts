import type { CronSchedule } from '@offerget/contracts';

const Weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function PartsAt(epochMs: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

/** 将 IANA 时区的墙上时间转换为 UTC；DST 跳时落入不存在时刻时选择转换器给出的首个有效时刻。 */
function ZonedEpoch(parts: LocalParts, timeZone: string): number {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  for (let index = 0; index < 4; index += 1) {
    const actual = PartsAt(guess, timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = target - actualAsUtc;
    if (adjustment === 0) return guess;
    guess += adjustment;
  }
  return guess;
}

function AddCalendarDays(parts: LocalParts, days: number): LocalParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: parts.hour, minute: parts.minute, second: parts.second };
}

export function CronTotalOccurrences(schedule: CronSchedule): number {
  return schedule.type === 'once' ? 1 : schedule.occurrences;
}

/** 返回一基 occurrence 的触发时间；超出总次数返回 null。重复任务始终按 IANA 本地日历推进，不做 `+24h`。 */
export function CronOccurrenceAt(schedule: CronSchedule, occurrence: number): number | null {
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > CronTotalOccurrences(schedule)) return null;
  const startEpoch = Date.parse(schedule.type === 'once' ? schedule.executeAt : schedule.startAt);
  if (!Number.isFinite(startEpoch)) throw new Error('Cron schedule start time is invalid.');
  if (schedule.type === 'once') return startEpoch;
  const start = PartsAt(startEpoch, schedule.timeZone);
  if (schedule.type === 'daily') return ZonedEpoch(AddCalendarDays(start, (occurrence - 1) * schedule.intervalDays), schedule.timeZone);

  const selected = new Set(schedule.daysOfWeek);
  const startDate = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const startDay = startDate.getUTCDay();
  const mondayOffset = (startDay + 6) % 7;
  let found = 0;
  for (let dayOffset = 0; dayOffset <= 366 * 200; dayOffset += 1) {
    const weekIndex = Math.floor((mondayOffset + dayOffset) / 7);
    if (weekIndex % schedule.intervalWeeks !== 0) continue;
    const candidate = AddCalendarDays(start, dayOffset);
    const weekday = Weekdays[new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day)).getUTCDay()];
    if (!selected.has(weekday)) continue;
    found += 1;
    if (found === occurrence) return ZonedEpoch(candidate, schedule.timeZone);
  }
  throw new Error('Cron weekly schedule exceeds the supported calendar horizon.');
}

export function ValidateCronScheduleTiming(schedule: CronSchedule, now = Date.now()): void {
  const first = CronOccurrenceAt(schedule, 1);
  if (first === null) throw new Error('Cron schedule has no occurrence.');
  if (schedule.type === 'once' && first <= now) throw Object.assign(new Error('A one-time CronTask must be scheduled in the future.'), { code: 'VALIDATION_ERROR' });
}
