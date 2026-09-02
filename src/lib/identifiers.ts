/**
 * Identifier format rules. ONE module, because this codebase has FOUR formats in play and mixing
 * them fails SILENTLY - a lookup just returns nothing and the UI shows "no bans" for a banned player.
 *
 * VERIFIED 2026-07-16 against the live DB and the Lua (do not re-derive; re-verify if it matters):
 *
 *   TABLE / COLUMN                    FORMAT                       WRITTEN BY
 *   users.identifier                  BARE hex (no prefix)         es_extended/server/functions.lua:353-355
 *                                                                  (string.gsub(v,'license:',''))
 *   gs_logs.source_identifier         BARE hex                     gs_utils logging (agrees with users)
 *   gs_logs.target_identifier         BARE hex
 *   bans.license                      PREFIXED 'license:xxx'       gs_weather/server/main.lua:125-130,169
 *                                                                  (getLicense returns id UNSTRIPPED)
 *   bans_identifiers.identifier       PREFIXED, ALL types          gs_weather/server/main.lua:232-234,369-371
 *                                     ('license:','discord:','ip:','steam:',…)
 *   citadel_identifiers.value         see below - NORMALIZED
 *
 * CITADEL's rule: store the BARE hex for `license`/`license2` (so citadel_identifiers.value joins
 * users.identifier directly, which is the hot path), and the BARE VALUE for every other type
 * (discord snowflake, steam id, …) with the kind carried in the `type` column. The prefix is a
 * FiveM transport detail, not data. Convert at the boundary with toPrefixed() whenever talking to
 * the ban tables or the game.
 */

export const IDENTIFIER_TYPES = [
  "license",
  "license2",
  "steam",
  "discord",
  "live",
  "xbl",
  "fivem",
  "ip",
  "token",
] as const;

export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

const TYPE_SET = new Set<string>(IDENTIFIER_TYPES);

/** Strip any 'type:' prefix -> bare value. 'license:AbC' -> 'abc'. Idempotent. */
export function toBare(raw: string): string {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0 && TYPE_SET.has(trimmed.slice(0, colon).toLowerCase())) {
    return normalizeValue(trimmed.slice(0, colon).toLowerCase() as IdentifierType, trimmed.slice(colon + 1));
  }
  return trimmed;
}

/** Add the FiveM 'type:' prefix - required by bans/bans_identifiers and the game bridge. */
export function toPrefixed(type: IdentifierType, bareValue: string): string {
  return `${type}:${bareValue}`;
}

/**
 * Split a raw FiveM identifier into (type, bare value).
 * Returns null for an unrecognized prefix rather than guessing - an unknown type must never be
 * silently coerced into the graph under the wrong kind.
 */
export function parseIdentifier(
  raw: string,
): { type: IdentifierType; value: string } | null {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const type = trimmed.slice(0, colon).toLowerCase();
  if (!TYPE_SET.has(type)) return null;
  return {
    type: type as IdentifierType,
    value: normalizeValue(type as IdentifierType, trimmed.slice(colon + 1)),
  };
}

/**
 * Canonical casing per type. Licenses/steam/fivem are hex-ish and case-insensitive in practice, so
 * they are lowercased to keep UNIQUE(type,value) from admitting near-duplicate rows. IPs and
 * snowflakes are left byte-exact.
 */
function normalizeValue(type: IdentifierType, value: string): string {
  const v = value.trim();
  switch (type) {
    case "license":
    case "license2":
    case "steam":
    case "fivem":
    case "xbl":
    case "live":
    case "token":
      return v.toLowerCase();
    default:
      return v;
  }
}

/** Bare hex for joining users.identifier / gs_logs.*_identifier. Accepts either form. */
export function normalizeLicense(raw: string): string {
  return toBare(raw).toLowerCase();
}

/** Prefixed form for the ban tables (`bans.license`, `bans_identifiers.identifier`). */
export function licenseForBans(raw: string): string {
  return toPrefixed("license", normalizeLicense(raw));
}

/**
 * Confidence tiers - design §6. WEAK is EVIDENCE ONLY and must never trigger an automatic action
 * (IP collisions are routine: CGNAT, households). A single token match is also weak; MULTIPLE
 * matching tokens is what the owner accepted as high confidence.
 */
export const IDENTIFIER_STRENGTH: Record<IdentifierType, "strong" | "medium" | "weak"> = {
  license: "strong",
  license2: "strong",
  fivem: "strong",
  token: "weak", // a SINGLE token; multi-token agreement is promoted to strong by the linker
  discord: "medium",
  steam: "medium",
  live: "medium",
  xbl: "medium",
  ip: "weak", // never a trigger - owner decision
};
