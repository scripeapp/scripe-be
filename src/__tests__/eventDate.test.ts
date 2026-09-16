import {
  EVENT_DATE_TBD_LABEL,
  isEventDateTbd,
  formatEventDate,
} from "../utils";

describe("isEventDateTbd", () => {
  it("returns true for null and undefined start dates", () => {
    expect(isEventDateTbd(null)).toBe(true);
    expect(isEventDateTbd(undefined)).toBe(true);
  });

  it("returns true for an empty string", () => {
    expect(isEventDateTbd("")).toBe(true);
  });

  it("returns false for a real start date", () => {
    expect(isEventDateTbd("2026-09-12")).toBe(false);
  });
});

describe("formatEventDate", () => {
  it("returns the TBD label when the start date is null", () => {
    expect(formatEventDate(null, "12:00")).toBe(EVENT_DATE_TBD_LABEL);
    expect(formatEventDate(undefined)).toBe(EVENT_DATE_TBD_LABEL);
  });

  it("joins date and time when both are present", () => {
    expect(formatEventDate("2026-09-12", "14:00:00")).toBe(
      "2026-09-12 · 14:00:00",
    );
  });

  it("falls back to the date alone when the time is missing", () => {
    expect(formatEventDate("2026-09-12", null)).toBe("2026-09-12");
  });
});
