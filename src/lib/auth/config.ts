/**
 * Auth.js v5 - Discord OAuth resolving to ONE session.
 * Design: _server_build/CITADEL_DESIGN.md §5. An in-game token provider joins this later and must
 * resolve to the SAME session/account - that is why identity lives in the graph, not in the session.
 *
 * DB sessions (not JWT) on purpose: an admin panel must be able to revoke a session immediately.
 * A JWT stays valid until it expires, which is the wrong property for a panel that can ban people.
 */
import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  citadelDiscordUsers,
  citadelOauthAccounts,
  citadelSessions,
  citadelUsers,
  citadelVerificationTokens,
} from "@/lib/db/schema/citadel";
import { auditDiscordLogin } from "@/lib/audit";
import { envInt } from "@/lib/security/rateLimit";
import { accountIdForDiscord } from "./identity";

const SESSION_DAYS = envInt("CITADEL_SESSION_DAYS", 7);
const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86400;
const SESSION_UPDATE_AGE_SECONDS = envInt("CITADEL_SESSION_UPDATE_AGE_SECONDS", 3600);

/**
 * ⚠ The adapter's types demand `timestamp` columns; ours are `datetime`, deliberately, and the cast
 * below is the seam. This is a TYPE-level mismatch only - the adapter reads and writes Date objects,
 * and `datetime({ mode: "date" })` produces exactly that, so runtime behaviour is identical.
 *
 * Why `datetime` is not negotiable here (probed on this MariaDB 10.4, explicit_defaults_for_timestamp=OFF):
 *   CREATE TABLE x (ts timestamp NOT NULL)  ->  `ts timestamp NOT NULL DEFAULT current_timestamp()
 *                                                ON UPDATE current_timestamp()`
 * MariaDB silently attaches ON UPDATE to a NOT NULL timestamp. On `citadel_sessions.expires` that
 * means the expiry RESETS on every write to the row - sessions would never expire, which is a
 * security bug in an admin panel that can ban people. A nullable `timestamp` is worse still: any
 * timestamp column after the first gets an implicit '0000-00-00' default that NO_ZERO_DATE rejects
 * outright (this is the ERROR 1067 the first migration hit).
 * `datetime` has none of that legacy behaviour. Correct schema > satisfying a generic.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: citadelUsers,
    accountsTable: citadelOauthAccounts,
    sessionsTable: citadelSessions,
    verificationTokensTable: citadelVerificationTokens,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any),
  providers: [
    Discord({
      clientId: process.env.AUTH_DISCORD_ID,
      clientSecret: process.env.AUTH_DISCORD_SECRET,
      /**
       * ⚠ WIDENED 2026-07-31 ON OWNER REQUEST. This line used to be `scope: "identify"` with the
       * comment "no email - we don't need it, don't store it". That decision is deliberately
       * reversed: the owner wants email and guild memberships captured, visible to Fondateur only.
       *
       * ⚠⚠ EXISTING USERS MUST RE-AUTHORISE. Discord does NOT retroactively grant new scopes to a
       * token that was issued without them. Everyone already logged in keeps working and will
       * silently produce NO email and NO guild list until they log out and back in. That is not a
       * bug to chase; it is how OAuth consent works. Expect the tables to fill in gradually.
       */
      authorization: { params: { scope: "identify email guilds" } },
      // ⚠ `id` MUST be the stable Discord snowflake - Auth.js uses profile.id as the OAuth account's
      // providerAccountId. Returning crypto.randomUUID() (a fresh value each login) meant
      // getUserByAccount never matched, so every login retried createUser and died on the discord_id
      // unique constraint. profile.id is the snowflake; it is also the join key into the identity graph.
      profile(profile) {
        return {
          id: profile.id,
          discordId: profile.id,
          name: profile.global_name ?? profile.username,
          // Null when the account has no verified email or the user declined the scope. Stored on
          // citadel_users.email, which already existed and was always written null until now.
          email: (profile as { email?: string | null }).email ?? null,
          image: profile.avatar
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
            : null,
        };
      },
    }),
  ],
  session: {
    strategy: "database",
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  pages: { signIn: "/login", error: "/login" },
  events: {
    /**
     * Seed the Discord @username cache from the logging-in user's OWN profile - the second writer of
     * citadel_discord_users besides the bot (design §4 note on the table). The raw OAuth profile
     * carries username / global_name / avatar, so we cache them without a round-trip to the bot.
     *
     * BEST-EFFORT ONLY: this is a cache convenience, never part of the auth result. It runs in an
     * `events` handler (whose return value Auth.js ignores) wrapped in try/catch, so a cache write can
     * NEVER break login. Presence enrichment reads this to show @handle for online players.
     */
    async signIn({ user, profile, account }) {
      try {
        const p = profile as
          | { id?: string; username?: string; global_name?: string; avatar?: string }
          | undefined;
        if (!p?.id) return;
        const now = new Date();
        const set = {
          username: p.username ?? null,
          globalName: p.global_name ?? null,
          avatar: p.avatar ?? null,
          updatedAt: now,
        };
        try {
          await db
            .insert(citadelDiscordUsers)
            .values({ discordId: p.id, ...set })
            .onDuplicateKeyUpdate({ set });
        } catch {
          // Do not fail login on a profile-cache write.
        }
        /**
         * Heal citadel_users.discord_id from the snowflake that JUST authenticated.
         * Seen 2026-08-16: oauth provider_account_id matched the identity graph, but
         * users.discord_id held a different snowflake, so LifeInvader resolved
         * ?error=unlinked despite a linked FiveM account. Session surfaces users.discord_id,
         * not the oauth row, so a drift here is a hard login failure.
         */
        try {
          const userId = (user as { id?: string } | undefined)?.id;
          const oauthDiscord =
            (account as { provider?: string; providerAccountId?: string } | null | undefined)
              ?.provider === "discord"
              ? (account as { providerAccountId?: string }).providerAccountId
              : undefined;
          const snowflake = oauthDiscord || p.id;
          if (userId && snowflake) {
            const graphAccountId = await accountIdForDiscord(snowflake);
            // Only rewrite discord_id when THIS login's snowflake is in the identity graph.
            // An email-linked Discord alt that never connected in-game must not clobber a working link.
            if (graphAccountId != null) {
              await db
                .update(citadelUsers)
                .set({ discordId: snowflake, accountId: graphAccountId })
                .where(eq(citadelUsers.id, userId));
            }
          }
        } catch {
          // Do not fail login on a denormalized-column heal.
        }
        try {
          await auditDiscordLogin(p.id, "discord_oauth");
        } catch {
          // Do not fail login on an audit mirror/write.
        }
        // Guild snapshot (owner request 2026-07-31). Needs the `guilds` scope AND a fresh access
        // token, so it only produces anything for someone who has re-authorised since the scope was
        // widened. Same best-effort contract as the two writes above: it cannot fail a login.
        try {
          const token = (account as { access_token?: string } | null | undefined)?.access_token;
          if (token) {
            const { captureUserGuilds } = await import("./guildCapture");
            await captureUserGuilds(p.id, token);
          }
        } catch {
          // Do not fail login on a guild-snapshot write.
        }
      } catch {
        // swallow - malformed provider payloads must never block or fail a sign-in
      }
    },
  },
  callbacks: {
    /**
     * Surface discordId on the session so identity resolution never re-queries the user row.
     *
     * ⚠ A single Auth.js user can hold MULTIPLE discord rows in citadel_oauth_accounts when Discord
     * accounts share an email and Auth.js links them (seen 2026-08-16: alt `1496…` + main `8671…`
     * on one user). Session used to trust users.discord_id alone, and a naive limit(1) on oauth can
     * pick the alt that has no citadel_identifiers row -> LifeInvader `?error=unlinked`. Prefer any
     * oauth snowflake that is in the identity graph; fall back to the denormalized column.
     */
    async session({ session, user }) {
      const u = user as typeof user & { discordId?: string | null; accountId?: number | null };
      let discordId = u.discordId ?? null;
      try {
        const oauthRows = await db
          .select({ providerAccountId: citadelOauthAccounts.providerAccountId })
          .from(citadelOauthAccounts)
          .where(
            and(
              eq(citadelOauthAccounts.userId, user.id),
              eq(citadelOauthAccounts.provider, "discord"),
            ),
          );
        for (const row of oauthRows) {
          const id = row.providerAccountId;
          if (!id) continue;
          if (await accountIdForDiscord(id)) {
            discordId = id;
            break;
          }
        }
      } catch {
        // fall through to the denormalized column
      }
      session.user.discordId = discordId;
      session.user.accountId = u.accountId ?? null;
      return session;
    },
  },
  trustHost: true, // self-hosted behind Caddy
});
