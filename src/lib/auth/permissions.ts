/**
 * PURE permission primitives - no DB import, no side effects. This is the leaf module that CLIENT
 * components (and the <Can> wrapper they render) can safely import: pulling `can()` or the `Identity`
 * type must NEVER drag the database (mysql2 → net/tls) into the client bundle.
 *
 * The db-bound resolvers live in identity.ts / rbac.ts, which import FROM here and re-export these
 * names for server-side callers - so existing `@/lib/auth/identity` and `@/lib/auth/rbac` imports on
 * the server keep working unchanged.
 */

export type Rank = {
  id: string; // 'support' | 'moderateur' | 'supermod' | 'admin' | 'fondateur' (config-driven - never hardcode)
  label: string;
  aceGroup: string; // ⚠ this is what users.group holds - NOT rank.id
  level: number; // higher = more power
  /** May this rank act on a target of its OWN level? Mirrors the game's
   *  ConfigStaff.CanTargetEqualRanks - see canTarget() in ./identity.ts. */
  canTargetEqual: boolean;
};

/**
 * A staff DIVISION - the SECOND, orthogonal authorization axis (gs_utils permissions config §4).
 * 'mortrp' | 'siem' | 'dossier' | 'norename' (config-driven - never hardcode the set).
 *
 * A division is NOT a rank and carries NO hierarchy: it never affects targeting (canTarget stays
 * rank-only, exactly like the game's ClearanceOutranks). `minLevel` is an ELIGIBILITY FLOOR for holding
 * the division - being that level does NOT grant it; membership is always explicit.
 */
export type Division = {
  id: string;
  label: string;
  minLevel: number;
};

export type Character = {
  identifier: string; // bare hex
  firstname: string | null;
  lastname: string | null;
  group: string | null;
  job: string | null;
  jobGrade: number | null;
  job2: string | null;
  job2Grade: number | null;
  disabled: boolean;
};

export type Identity = {
  accountId: number;
  discordId: string | null;
  character: Character | null;
  rank: Rank | null;
  /** Rank codes UNIONED with every qualifying division's codes - see rbac.permissionsForIdentity. */
  permissions: Set<string>;
  /**
   * Division ids this person holds AND currently qualifies for. Advisory/labelling ONLY: the codes
   * are already folded into `permissions`, so gate on can(identity, 'mortrp.execute') - never on
   * `divisions.has('mortrp')`, which would silently exclude the Fondateur (who holds every division
   * code via '*' without any membership row).
   */
  divisions: Set<string>;
  /** RP display name - never the Discord/Steam username (CLAUDE.md owner rule). */
  displayName: string;
};

/** Does this granted-code set satisfy `code`? Honours '*' and 'prefix.*'. */
export function grantsInclude(granted: Set<string>, code: string): boolean {
  if (granted.has("*")) return true;
  if (granted.has(code)) return true;
  // 'player.kick' is satisfied by 'player.*'
  const parts = code.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    if (granted.has(`${parts.slice(0, i).join(".")}.*`)) return true;
  }
  return false;
}

/** Deny-by-default capability check. No identity, no rank, no code -> false. */
export function can(identity: Identity | null, code: string): boolean {
  if (!identity) return false;
  return grantsInclude(identity.permissions, code);
}
