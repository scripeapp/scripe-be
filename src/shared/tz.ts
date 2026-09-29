const formatters = new Map<string, Intl.DateTimeFormat>();

interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClockParts(utcMilliseconds: number, timeZone: string): WallClockParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMilliseconds));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  // Some ICU builds render midnight as 24:00 under hourCycle "h23".
  if (values["hour"] === 24) values["hour"] = 0;
  return {
    year: values["year"] ?? 0,
    month: values["month"] ?? 0,
    day: values["day"] ?? 0,
    hour: values["hour"] ?? 0,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0,
  };
}

/**
 * Wall-clock offset of `timeZone` from UTC at the given instant, in seconds.
 * Positive when local time is ahead of UTC (e.g. a Lagos afternoon).
 */
export function timeZoneOffsetSeconds(timeZone: string, atUtcMilliseconds: number): number {
  const local = wallClockParts(atUtcMilliseconds, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - atUtcMilliseconds) / 1000);
}

/**
 * Reinterpret a local wall-clock time ("2026-10-05 09:30") as an instant in
 * `timeZone`, returning epoch milliseconds. Two-pass so a DST transition inside
 * the offset window cannot skew the result.
 */
export function localDateTimeToUtcMilliseconds(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offsetSeconds = timeZoneOffsetSeconds(timeZone, naiveUtc);
  const utcMilliseconds = naiveUtc - offsetSeconds * 1000;
  offsetSeconds = timeZoneOffsetSeconds(timeZone, utcMilliseconds);
  return naiveUtc - offsetSeconds * 1000;
}

/** Local wall clock at the given instant: date as YYYY-MM-DD, time as HH:mm (minutes precision). */
export function utcToLocalDateTime(
  utcMilliseconds: number,
  timeZone: string,
): { date: string; time: string } {
  const local = wallClockParts(utcMilliseconds, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${local.year}-${pad(local.month)}-${pad(local.day)}`,
    time: `${pad(local.hour)}:${pad(local.minute)}`,
  };
}

/** 0 for Sunday, 1 for Monday, ... 6 for Saturday — matches Date#getDay(). */
export function localDateWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}