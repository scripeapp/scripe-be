import {
  localDateTimeToUtcMilliseconds,
  localDateWeekday,
  timeZoneOffsetSeconds,
  utcToLocalDateTime,
} from "./tz.js";

describe("tz", () => {
  describe("timeZoneOffsetSeconds", () => {
    it("returns Africa/Lagos UTC+1 in January", () => {
      expect(timeZoneOffsetSeconds("Africa/Lagos", Date.UTC(2026, 0, 5, 12, 0, 0))).toBe(3600);
    });

    it("returns Europe/Berlin UTC+1 in January and UTC+2 in July", () => {
      const january = Date.UTC(2026, 0, 5, 12, 0, 0);
      expect(timeZoneOffsetSeconds("Europe/Berlin", january)).toBe(3600);
      const july = Date.UTC(2026, 6, 5, 12, 0, 0);
      expect(timeZoneOffsetSeconds("Europe/Berlin", july)).toBe(7200);
    });
  });

  describe("localDateTimeToUtcMilliseconds", () => {
    it("converts a Lagos summer afternoon to its UTC instant", () => {
      const utc = localDateTimeToUtcMilliseconds("2026-07-05", "14:30", "Africa/Lagos");
      // 14:30 WAT (UTC+1) == 13:30 UTC.
      expect(new Date(utc).toISOString()).toBe("2026-07-05T13:30:00.000Z");
    });

    it("keeps Europe/Berlin DST handling intact across the spring transition", () => {
      // 2026-03-29 is the spring-forward day in Berlin (02:00->03:00).
      const before = localDateTimeToUtcMilliseconds("2026-03-29", "01:30", "Europe/Berlin");
      expect(new Date(before).toISOString()).toBe("2026-03-29T00:30:00.000Z");
      // A nonexistent 02:30 is ambiguous; the two-pass offset steadily lands
      // on one valid instant (here the pre-transition +1 offset) — never throws.
      const inGap = localDateTimeToUtcMilliseconds("2026-03-29", "02:30", "Europe/Berlin");
      expect(new Date(inGap).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });
  });

  describe("utcToLocalDateTime", () => {
    it("renders local date and time for a Lagos booking", () => {
      const local = utcToLocalDateTime(Date.parse("2026-10-05T11:00:00.000Z"), "Africa/Lagos");
      expect(local).toEqual({ date: "2026-10-05", time: "12:00" });
    });
  });

  describe("localDateWeekday", () => {
    it("treats 2026-10-05 (a Monday) as 1", () => {
      expect(new Date("2026-10-05T00:00:00.000Z").getUTCDay()).toBe(1);
      expect(localDateWeekday("2026-10-05")).toBe(1);
    });
  });
});