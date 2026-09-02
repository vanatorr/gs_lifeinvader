import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "./config";
import { can, resolveIdentity, resolveIdentityByAccountId, type Identity } from "./identity";

/**
 * Page-level authorization. Design §5.3, TRAP #1:
 *
 *   "server-side does NOT mean authorized. `await db.select().from(gsLogs)` in a page with no
 *    check = anyone who loads /logs reads every log."
 *
 * A server component runs on the server, but it renders because a PUBLIC url was requested. Being
 * server-side is a statement about where code runs, not about who asked. Every page calls this.
 */

/**
 * Resolve identity from the current Auth.js session (Discord OAuth or in-game redeem).
 *
 * ⚠ WRAPPED IN REACT `cache()`, AND IT MUST NEVER BECOME A MODULE-LEVEL OR `globalThis` CACHE
 * INSTEAD. React's `cache()` memoizes PER REQUEST (the App Router's request-scoped render) - two
 * different users hitting this on the same server process never share a result. A `globalThis`/`Map`
 * cache keyed on nothing (this function takes no arguments) would hand the FIRST caller's identity to
 * every OTHER request that lands on the same process until it expired - i.e. one player's session
 * served to another player. The next person tempted to "optimize" this into a longer-lived cache for
 * a bigger hit rate must not: request-scoping is not incidental here, it is the entire safety
 * property.
 *
 * The root layout calls this, and then every single page calls it again on top - each call used to
 * run cold: `auth()` (a DB round trip, `strategy: "database"`), then `accountIdForDiscord`, then
 * `licensesForAccount`, then a `characterForLicense` per license. Measured at roughly 30 queries and
 * 26 serialized round trips on a single CAD page load, before that page had fetched anything of its
 * own. `cache()` collapses every one of those repeated calls within ONE request into a single
 * resolution - this is the single biggest page-load win in this pass.
 */
export const resolveSessionIdentity = cache(async (): Promise<Identity | null> => {
  const session = await auth();
  if (!session?.user) return null;

  const discordId = session.user.discordId;
  if (discordId) return resolveIdentity(discordId);

  const accountId = session.user.accountId;
  if (accountId != null && accountId > 0) return resolveIdentityByAccountId(accountId);

  return null;
});

/**
 * The signed-in identity, or redirect to login. Does NOT imply any permission.
 *
 * `next` (an internal path such as "/cad/da") is carried into /login so the sign-in flow can land
 * the user back where they were headed instead of the default /staff (owner, 2026-08-26: "if player
 * signin to CAD it redirects to /staff instead of CAD"). Callers that know their surface pass it;
 * staff pages omit it since /staff is already the default landing.
 */
export async function requireIdentity(next?: string): Promise<Identity> {
  const identity = await resolveSessionIdentity();
  if (!identity) {
    const session = await auth();
    const nextOk = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
    // Discord OAuth with no linked graph account vs no session at all.
    if (session?.user?.discordId) {
      redirect(`/login?error=unlinked${nextOk ? `&next=${encodeURIComponent(nextOk)}` : ""}`);
    }
    redirect(nextOk ? `/login?next=${encodeURIComponent(nextOk)}` : "/login");
  }
  return identity;
}

/** Identity + a required capability. Deny-by-default. */
export async function requirePermission(code: string): Promise<Identity> {
  const identity = await requireIdentity();
  if (!can(identity, code)) redirect("/login?error=denied");
  return identity;
}

/** Non-redirecting read, for layouts that render differently rather than bouncing. */
export async function getIdentity(): Promise<Identity | null> {
  return resolveSessionIdentity();
}
