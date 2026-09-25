import { settlementNameMatches } from "./banking.name-match.js";

describe("settlementNameMatches", () => {
  it.each([
    ["Acme Ventures Nigeria Limited", "ACME VENTURES NIG LTD"],
    ["Acme Ventures Limited", "ACME VENTURES LTD"],
    ["Bright & Co International Services Ltd", "BRIGHT AND CO INTERNATIO SERVICES"],
    ["Adaeze Grace Okafor", "OKAFOR ADAEZE GRACE"],
  ])("accepts %s ≈ %s", (expected, resolved) => {
    expect(settlementNameMatches(expected, resolved)).toBe(true);
  });

  it.each([
    ["Acme Ventures Nigeria Limited", "JOHN DOE"],
    ["Dangote Cement Plc", "ADAEZE OKAFOR"],
    ["Acme Ventures Limited", "ACME LOGISTICS FOODS"],
    ["Acme Limited", "LIMITED"],
  ])("rejects %s vs %s", (expected, resolved) => {
    expect(settlementNameMatches(expected, resolved)).toBe(false);
  });
});
