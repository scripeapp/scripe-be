/**
 * Bank-resolved account names are upper-cased, often truncated and
 * inconsistent about company suffixes ("ACME VENTURES NIG LTD" vs "Acme
 * Ventures Nigeria Limited"). A match requires most of the distinctive words
 * of one name to appear in the other — enough to reject an unrelated
 * person's or company's account without rejecting ordinary bank formatting.
 */
const IGNORED_TOKENS = new Set([
  "LTD",
  "LIMITED",
  "PLC",
  "NIG",
  "NIGERIA",
  "NG",
  "CO",
  "COMPANY",
  "ENT",
  "ENTERPRISE",
  "ENTERPRISES",
  "INC",
  "LLC",
  "THE",
  "AND",
  "OF",
  "RC",
  "BN",
]);

const MINIMUM_OVERLAP = 0.66;

function tokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !IGNORED_TOKENS.has(token));
}

export function settlementNameMatches(expected: string, resolved: string): boolean {
  const expectedTokens = new Set(tokens(expected));
  const resolvedTokens = new Set(tokens(resolved));
  if (expectedTokens.size === 0 || resolvedTokens.size === 0) return false;
  let shared = 0;
  for (const token of expectedTokens) {
    // Banks truncate long names, so a resolved token that is a prefix of
    // the expected one (e.g. "INTERNATIO" for "INTERNATIONAL") still counts.
    if (resolvedTokens.has(token) || [...resolvedTokens].some((candidate) => candidate.length >= 4 && token.startsWith(candidate))) shared += 1;
  }
  return shared / Math.min(expectedTokens.size, resolvedTokens.size) >= MINIMUM_OVERLAP;
}
