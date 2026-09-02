/**
 * Identity resolution: session -> person -> character -> capabilities.
 * Design: _server_build/CITADEL_DESIGN.md §5.1. This is THE crux the whole platform sits on.
 *
 * THE CHAIN
 *   Auth.js session (Discord)
 *     -> citadel_identifiers(type='discord', value=<discord user id>)   [UNIQUE(type,value)]
 *     -> citadel_accounts.id                                            (the PERSON)
 *     -> citadel_identifiers(type='license')                            (their character key)
 *     -> users.identifier                                               (ESX character row)
 *     -> users.group -> staff_ranks.ace_group                           (staff rank + level)
 *     -> staff_rank_permissions                                         (capability codes)
 *     -> users.job / users.job2                                         (faction panels)
 *
 * ⚠ LICENSE FORMAT - verified against the live DB and the Lua on 2026-07-16, and it CONTRADICTS
 * the original brief (which said users.identifier = "license:xxx"):
 *   es_extended/server/functions.lua:353-355 STRIPS the prefix before writing the row
 *       if string.match(v, 'license:') then local identifier = string.gsub(v, 'license:', '')
 *   so `users.identifier` holds BARE 40-char hex (e.g. 3f4649d5...), and
 *   es_extended/server/classes/player.lua:54 RE-ADDS the prefix for xPlayer.license.
 *   gs_logs.source_identifier agrees (bare hex). CITADEL therefore normalizes every license to
 *   BARE HEX at the boundary via normalizeLicense(), so citadel_identifiers.value joins
 *   users.identifier directly. The future connect hook must call this too - FiveM's
 *   GetPlayerIdentifiers() returns the PREFIXED form.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelIdentifiers } from "@/lib/db/schema/citadel";
import { users } from "@/lib/db/schema/game";
import { normalizeLicense } from "@/lib/identifiers";
import { divisionsForLicenses, permissionsForIdentity, rankForGroup } from "./rbac";
// Pure types + can() live in permissions.ts (db-free, client-safe). Re-exported here so server code
// keeps importing Identity/Character/can from "@/lib/auth/identity" unchanged.
import { can, type Character, type Division, type Identity, type Rank } from "./permissions";
export { can } from "./permissions";
export type { Character, Division, Identity, Rank } from "./permissions";

/** Resolve the identity-graph account behind a Discord user id. Null = not linked yet. */
export async function accountIdForDiscord(discordId: string): Promise<number | null> {
  const row = await db
    .select({ accountId: citadelIdentifiers.accountId })
    .from(citadelIdentifiers)
    .where(
      and(eq(citadelIdentifiers.type, "discord"), eq(citadelIdentifiers.value, discordId)),
    )
    .limit(1);
  return row[0]?.accountId ?? null;
}

/** Resolve the identity-graph account behind a bare-hex license identifier. Null = not linked yet. */
export async function accountIdForLicense(license: string): Promise<number | null> {
  const row = await db
    .select({ accountId: citadelIdentifiers.accountId })
    .from(citadelIdentifiers)
    .where(
      and(
        eq(citadelIdentifiers.type, "license"),
        eq(citadelIdentifiers.value, normalizeLicense(license)),
      ),
    )
    .limit(1);
  return row[0]?.accountId ?? null;
}

/** Every license identifier attached to an account (a person may hold several). */
export async function licensesForAccount(accountId: number): Promise<string[]> {
  const rows = await db
    .select({ value: citadelIdentifiers.value })
    .from(citadelIdentifiers)
    .where(
      and(eq(citadelIdentifiers.accountId, accountId), eq(citadelIdentifiers.type, "license")),
    );
  return rows.map((r) => r.value);
}

async function characterForLicense(license: string): Promise<Character | null> {
  const row = await db
    .select({
      identifier: users.identifier,
      firstname: users.firstname,
      lastname: users.lastname,
      group: users.group,
      job: users.job,
      jobGrade: users.jobGrade,
      job2: users.job2,
      job2Grade: users.job2Grade,
      disabled: users.disabled,
    })
    .from(users)
    .where(eq(users.identifier, license))
    .limit(1);

  const r = row[0];
  if (!r) return null;
  return { ...r, disabled: r.disabled === 1 };
}

async function identityForAccount(
  accountId: number,
  discordId: string | null,
): Promise<Identity | null> {
  const licenses = await licensesForAccount(accountId);

  // A person may hold several characters; the staff rank is a property of the PERSON, so take the
  // highest-ranked one rather than whichever row sorts first.
  //
  // ⚠ RESOLVED IN PARALLEL, NOT SEQUENTIALLY. Each license's (characterForLicense, rankForGroup) pair
  // is independent of every other license, so the old `for` loop paying one full round trip per
  // license before starting the next was pure serialized latency for nothing - part of the ~26
  // serialized round trips a single CAD page load paid before this fix (see resolveSessionIdentity's
  // doc in lib/auth/session.ts). `Promise.all` preserves array order, so the tie-break below (first
  // license wins on an EQUAL rank) is unchanged from the sequential version.
  const resolved = await Promise.all(
    licenses.map(async (license) => {
      const c = await characterForLicense(license);
      if (!c) return null;
      const r = await rankForGroup(c.group);
      return { character: c, rank: r };
    }),
  );

  let character: Character | null = null;
  let rank: Rank | null = null;
  for (const entry of resolved) {
    if (!entry) continue;
    if (!character || (entry.rank?.level ?? 0) > (rank?.level ?? 0)) {
      character = entry.character;
      rank = entry.rank;
    }
  }

  // Capabilities = rank codes UNIONED with every qualifying DIVISION's codes.
  // ⚠ Pass ALL licenses, not just the winning character's: the loop above deliberately keeps only the
  // highest-RANKED character, but a division is a property of the PERSON while its membership row keys
  // on a CHARACTER. Narrowing to `character.identifier` here would silently drop a division held on
  // any other character of the same account.
  const permissions = await permissionsForIdentity(rank, licenses);
  const divisions = rank ? await divisionsForLicenses(licenses, rank.level) : new Set<string>();

  const displayName =
    character && (character.firstname || character.lastname)
      ? `${character.firstname ?? ""} ${character.lastname ?? ""}`.trim()
      : "Sans personnage";

  return { accountId, discordId, character, rank, permissions, divisions, displayName };
}

/**
 * Full identity for a Discord id. Returns null when the Discord account is not linked to any
 * identity-graph account - which, until the in-game capture hook lands, is EVERYONE except the
 * bootstrapped founder. That is expected, not an error: they log in and see zero panels.
 */
export async function resolveIdentity(discordId: string): Promise<Identity | null> {
  const accountId = await accountIdForDiscord(discordId);
  if (accountId === null) return null;
  return identityForAccount(accountId, discordId);
}

/** In-game redeem mints a session with accountId only (no Discord). Same identity graph as OAuth. */
export async function resolveIdentityByAccountId(accountId: number): Promise<Identity | null> {
  if (!accountId) return null;
  return identityForAccount(accountId, null);
}

/**
 * Hierarchy gate - mirror of the game's ClearanceOutranks: acting ON a staff member requires a
 * STRICTLY higher level. Equal ranks cannot touch each other.
 */
export async function canTarget(
  actor: Identity | null,
  targetLicense: string,
): Promise<boolean> {
  if (!actor?.rank) return false;
  const target = await characterForLicense(normalizeLicense(targetLicense));
  if (!target) return false;
  const targetRank = await rankForGroup(target.group);
  if (!targetRank) return true; // target is not staff - actor's own permission still gates the action

  // Strictly higher always wins.
  if (actor.rank.level > targetRank.level) return true;

  /**
   * EQUAL rank: allowed only when the ACTOR's rank opts in - the exact second branch of the game's
   * ClearanceOutranks (gs_utils/modules/permissions/server/main.lua):
   *
   *     if srcLevel > targetLevel then return true end
   *     if srcLevel == targetLevel then
   *         return ConfigStaff.CanTargetEqualRanks[srcRankId] == true
   *     end
   *     return false
   *
   * ⚠ FIXED 2026-07-17 - this function used to be JUST `actor.rank.level > targetRank.level`, i.e. the
   * first line only, because CanTargetEqualRanks lived exclusively in a Lua table this process cannot
   * read. The consequence was total, not cosmetic: EVERY staff member on this server is `fondateur`
   * (level 5 - verified against the live DB, 8 of 8), so `5 > 5` was false for every staff-on-staff
   * page, `viewerCan.canTargetPlayer` was false, and the panel disabled EVERY action for EVERY user,
   * including on their own page. The owner's report was simply "ca marche pas" / "c bloqued".
   * The game now publishes the rule into `staff_ranks.can_target_equal` so this can mirror it rather
   * than guess. Note it keys off the ACTOR's rank, never the target's.
   *
   * Still deny-by-default: a rank without the flag cannot touch its peers, and a LOWER rank can never
   * touch a higher one. This does not relax ClearanceCommission's stricter separate ceiling (you may never
   * grant a rank at or above your own) - that lives in setStaffRankAction.
   */
  if (actor.rank.level === targetRank.level) return actor.rank.canTargetEqual;

  return false;
}
