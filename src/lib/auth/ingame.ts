import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  citadelAccounts,
  citadelAuthCodes,
  citadelIdentifiers,
  citadelSessions,
  citadelUsers,
} from "@/lib/db/schema/citadel";
import { users } from "@/lib/db/schema/game";
import { envInt } from "@/lib/security/rateLimit";

/**
 * Redeem an in-game auth code for a real session (design §5.1 - the second path to ONE session).
 *
 * THE SECURITY PROPERTY THAT MATTERS: the code is single-use and short-lived, and it is spent
 * SERVER-SIDE the instant it arrives. TASEv3's equivalent stayed live in the URL forever, so browser
 * history was a working credential. Here, by the time the URL is in history the code is already
 * dead - a stolen link is a spent ticket.
 *
 * The claim is atomic. `UPDATE … WHERE used_at IS NULL AND expires_at > now` plus the affected-row
 * count IS the guard: two concurrent redemptions race on one row and exactly one wins. A
 * read-then-write would let both pass the check before either wrote.
 */

const SESSION_DAYS = envInt("CITADEL_SESSION_DAYS", 7);

export type RedeemResult =
  | { ok: true; sessionToken: string; expires: Date; route: string | null; accountId: number }
  | { ok: false; reason: "invalid" | "no-character" };

export async function redeemAuthCode(code: string): Promise<RedeemResult> {
  if (!code || code.length > 64) return { ok: false, reason: "invalid" };

  // Read first purely to recover the payload AFTER a successful claim; the claim below is what
  // actually authorizes, so a stale read here cannot grant anything.
  const claim = await db
    .update(citadelAuthCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(citadelAuthCodes.code, code),
        isNull(citadelAuthCodes.usedAt),
        gt(citadelAuthCodes.expiresAt, new Date()),
      ),
    );

  // Unknown / already used / expired all land here. We deliberately do NOT tell the caller which:
  // "that code exists but expired" is free information for an attacker.
  //
  // ⚠ The result shape is driver-specific and getting it wrong fails SILENTLY. drizzle-mysql2
  // returns mysql2's raw `[ResultSetHeader, FieldPacket[]]`, so the count is `res[0].affectedRows`.
  // `rowsAffected` (the PlanetScale/other-driver name) is `undefined` here, which coerced to 0 and
  // made EVERY redemption fail closed - caught by scripts/verify-ingame-auth.ts, not by types.
  const affected = (claim as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  if (affected === 0) return { ok: false, reason: "invalid" };

  const row = await db
    .select({
      license: citadelAuthCodes.license,
      route: citadelAuthCodes.route,
      name: citadelAuthCodes.issuedToName,
    })
    .from(citadelAuthCodes)
    .where(eq(citadelAuthCodes.code, code))
    .limit(1);

  const claimed = row[0];
  if (!claimed) return { ok: false, reason: "invalid" };

  // The character must exist: the code carries a license, and a session pointing at nothing would be
  // a confusing dead end rather than an honest failure.
  const character = await db
    .select({ firstname: users.firstname, lastname: users.lastname })
    .from(users)
    .where(eq(users.identifier, claimed.license))
    .limit(1);

  if (!character[0]) return { ok: false, reason: "no-character" };

  const rpName =
    `${character[0].firstname ?? ""} ${character[0].lastname ?? ""}`.trim() || claimed.name || "Joueur";

  // Normally gs_citadel's connect hook already created the account; this covers redeeming before a
  // first capture (or after a wipe of citadel_*).
  const accountId = (await accountForLicense(claimed.license)) ?? (await createAccount(claimed.license, rpName));

  // Both auth paths converge on the same citadel_users row via account_id - that convergence is the
  // whole point of "Discord OAuth + in-game token, both resolving to ONE session".
  const userId = await userForAccount(accountId, rpName);

  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(citadelSessions).values({ sessionToken, userId, expires });

  return { ok: true, sessionToken, expires, route: claimed.route, accountId };
}

async function accountForLicense(license: string): Promise<number | null> {
  const row = await db
    .select({ accountId: citadelIdentifiers.accountId })
    .from(citadelIdentifiers)
    .where(and(eq(citadelIdentifiers.type, "license"), eq(citadelIdentifiers.value, license)))
    .limit(1);
  return row[0]?.accountId ?? null;
}

async function createAccount(license: string, displayName: string): Promise<number> {
  const inserted = await db
    .insert(citadelAccounts)
    .values({ displayName, notes: "Created on in-game portal redemption" })
    .$returningId();

  const accountId = inserted[0].id;
  await db.insert(citadelIdentifiers).values({
    accountId,
    type: "license",
    value: license,
    sessionCount: 0, // the connect hook owns session counting; this row is a link, not a visit
  });
  return accountId;
}

async function userForAccount(accountId: number, name: string): Promise<string> {
  const existing = await db
    .select({ id: citadelUsers.id })
    .from(citadelUsers)
    .where(eq(citadelUsers.accountId, accountId))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = crypto.randomUUID();
  await db.insert(citadelUsers).values({ id, accountId, name });
  return id;
}
