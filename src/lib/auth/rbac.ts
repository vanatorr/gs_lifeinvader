/**
 * Contractor dev stub: no staff RBAC tables. Network admin uses DEV_NETWORK_ADMIN_DISCORD_IDS.
 * Merge back into full citadel/src/lib/auth/rbac.ts before production deploy.
 */
import { grantsInclude, type Division, type Rank } from "./permissions";

export { grantsInclude, type Rank } from "./permissions";
export type { Division } from "./permissions";

type RbacSnapshot = {
  version: string;
  loadedAt: number;
  ranksByAceGroup: Map<string, Rank>;
  ranksById: Map<string, Rank>;
  permissionsByRankId: Map<string, Set<string>>;
  divisionsById: Map<string, Division>;
  permissionsByDivisionId: Map<string, Set<string>>;
  divisionsByIdentifier: Map<string, Set<string>>;
};

const EMPTY: RbacSnapshot = {
  version: "contractor",
  loadedAt: Date.now(),
  ranksByAceGroup: new Map(),
  ranksById: new Map(),
  permissionsByRankId: new Map(),
  divisionsById: new Map(),
  permissionsByDivisionId: new Map(),
  divisionsByIdentifier: new Map(),
};

async function snapshot(): Promise<RbacSnapshot> {
  return EMPTY;
}

export async function rankForGroup(_group: string | null | undefined): Promise<Rank | null> {
  return null;
}

export async function permissionsForIdentity(
  _group: string | null | undefined,
  _licenses: string[],
): Promise<Set<string>> {
  return new Set();
}

export async function divisionsForLicenses(_licenses: string[]): Promise<Set<string>> {
  return new Set();
}

export async function staffConfigVersion(): Promise<string> {
  return "contractor";
}

export { snapshot as loadRbacSnapshot };
