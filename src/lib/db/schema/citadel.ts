/**
 * CITADEL-owned tables - the ONLY schema drizzle-kit migrates (tablesFilter: citadel_*).
 * Game-owned tables live in ./game.ts and are never migrated from here.
 * Design: _server_build/CITADEL_DESIGN.md §4.
 *
 * NOTE: columns use `datetime`, not `timestamp` - this MariaDB 10.4 runs
 * explicit_defaults_for_timestamp=OFF, where a bare nullable `timestamp` gets an implicit
 * zero-date default that strict mode rejects. Same choice the game's own tables (gs_logs) make.
 * `updated_at` columns are app-maintained on UPDATE (MariaDB ON UPDATE is timestamp-era magic
 * we deliberately avoid; every write path sets it explicitly).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  decimal,
  float,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { CITADEL_TABLES as CT } from "../tables";
import { localDatetime as datetime, parsedJson } from "../types";
// Type-only, and DB-free by construction (lib/data/manualModel.ts imports nothing) - the manual's
// field definitions are shared verbatim by the schema, the server actions and the client editor, so
// they live in one place rather than being re-declared three times and drifting.
import type { ManualFieldDef } from "@/lib/data/manualModel";

const createdNow = (name: string) =>
  datetime(name, { mode: "date" }).default(sql`CURRENT_TIMESTAMP`).notNull();
const nullableDate = (name: string) => datetime(name, { mode: "date" });

/* ── Auth.js (adapter shape; prefixed - ESX already owns `users`) ────────────── */

export const citadelUsers = mysqlTable(CT.users, {
  id: varchar("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  discordId: varchar("discord_id", { length: 32 }).unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).unique(),
  emailVerified: nullableDate("email_verified"),
  image: varchar("image", { length: 255 }),
  // Denormalized pointer to the identity-graph account (resolved via citadel_identifiers).
  accountId: bigint("account_id", { mode: "number" }),
  createdAt: createdNow("created_at"),
});

export const citadelOauthAccounts = mysqlTable(
  CT.oauthAccounts,
  {
    userId: varchar("user_id", { length: 36 }).notNull(),
    type: varchar("type", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: int("expires_at"),
    token_type: varchar("token_type", { length: 255 }),
    scope: varchar("scope", { length: 255 }),
    id_token: text("id_token"),
    session_state: varchar("session_state", { length: 255 }),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("idx_oauth_user").on(t.userId),
  ],
);

export const citadelSessions = mysqlTable(CT.sessions, {
  sessionToken: varchar("session_token", { length: 255 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  expires: datetime("expires", { mode: "date" }).notNull(),
});

export const citadelVerificationTokens = mysqlTable(
  CT.verificationTokens,
  {
    identifier: varchar("identifier", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expires: datetime("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/**
 * In-game auth codes - the second path to ONE session (design §5.1: "Discord OAuth + in-game token,
 * both resolving to ONE session").
 *
 * This is the corrected version of TASEv3's `TASE_AUTH_PLAYER` (its 4 surviving client files show
 * the shape; the implementation is gone). Everything below is a fix for something that design got
 * wrong - see TASEv3/client/functions/tase.lua:11-19:
 *   - it never expired            -> `expires_at`, short TTL
 *   - it was replayable           -> `used_at`, single-use
 *   - it was cached forever in a  -> the code dies on redemption; the session cookie is the
 *     client-side Lua local          durable credential, not the code
 *   - it rode in a URL query      -> the code is exchanged server-side IMMEDIATELY for a session;
 *     string (leaks via history,     it is worthless the moment it is used, so a leaked URL in
 *     referrers, logs)               browser history is a spent ticket
 *
 * The code is minted server-side in-game (identity from `source`, never client-claimed) and carries
 * the LICENSE - the character key - not a user id: the web side resolves the account from it exactly
 * the way the Discord path does, so both paths converge on the same identity resolution.
 */
export const citadelAuthCodes = mysqlTable(
  CT.authCodes,
  {
    code: varchar("code", { length: 64 }).primaryKey(),
    license: varchar("license", { length: 128 }).notNull(), // bare hex - joins users.identifier
    route: varchar("route", { length: 64 }), // deep-link target, e.g. 'staff' (TASEv3's `route` idea)
    issuedToName: varchar("issued_to_name", { length: 64 }),
    expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
    usedAt: nullableDate("used_at"),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_auth_codes_expiry").on(t.expiresAt)],
);

/**
 * Discord profile cache - snowflake → @username / display name / avatar.
 *
 * gs_citadel captures the Discord SNOWFLAKE at connect (citadel_identifiers type='discord'), but not
 * the human-readable @username. Two writers fill this cache: the Discord bot (resolves ids via the
 * Discord API for anyone online) and OAuth login (Auth.js profile). Presence enrichment reads it so
 * the online list can show "[id] Firstname Lastname | @username" - the RP name from `users`, the
 * @handle from here, never the Steam/FiveM username (CLAUDE.md owner rule).
 */
export const citadelDiscordUsers = mysqlTable(CT.discordUsers, {
  discordId: varchar("discord_id", { length: 32 }).primaryKey(),
  username: varchar("username", { length: 64 }), // the @handle (Discord's new handle-based username)
  globalName: varchar("global_name", { length: 64 }), // display name
  avatar: varchar("avatar", { length: 128 }), // avatar hash (build the CDN URL client-side)
  updatedAt: createdNow("updated_at"), // app-maintained; refreshed on each resolve
});

/* ── Discord guild registry / role mapping (2026-07-16) ──────────────────────────────────────
 *
 * OWNER DECISION (2026-07-16): CITADEL owns Discord role MEMBERSHIP - who holds a role is decided
 * here and nowhere else. What CITADEL deliberately does NOT own is the role's own configuration:
 * its permissions, colour, name and position stay editable in Discord by hand. The sync engine
 * therefore only ever calls member role add/remove + nickname; it never edits a role object.
 *
 * ⚠ THE ENFORCEMENT CEILING, stated once so nobody re-derives it: **Discord has no API to lock
 * role membership.** There is no "only this bot may grant this role" flag anywhere in the product.
 * "Blocked" is unreachable; what is reachable is three layers that together approximate it:
 *   1. RECONCILE - a sync computes desired state and strips managed roles the account shouldn't
 *      hold (bot/handlers/syncMember.ts). Eventually correct, seconds-to-minutes late.
 *   2. LIVE REVERT - GuildMemberUpdate reverts a hand-made change in ~1s and audits it as drift.
 *      Needs the PRIVILEGED GuildMembers intent (bot/discord.ts, env DISCORD_GUILD_MEMBERS_INTENT).
 *   3. DISCORD SERVER SETTINGS - the actual prevention: don't grant humans `Manage Roles`, and put
 *      the bot's role above every managed role. Layers 1-2 are the safety net for when that slips.
 * A role that is NOT in citadel_discord_rank_roles is never read, never written, never touched.
 */

/**
 * Guilds the bot is actually a member of - AUTO-DISCOVERED, never configured (owner rule: no
 * hardcoded ids; owner decision 2026-07-16 chose discovery over an env list so inviting the bot
 * somewhere new needs no deploy). The bot mirrors its real gateway guild list here on ready and on
 * guildCreate/guildDelete/guildUpdate; staff then tick `managed` on Page 9. Discovery is NOT
 * consent: `managed` defaults FALSE, so being invited to a guild grants CITADEL nothing until a
 * human with discord.manage says so. The sync engine skips every unmanaged guild.
 */
export const citadelDiscordGuilds = mysqlTable(CT.discordGuilds, {
  guildId: varchar("guild_id", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  icon: varchar("icon", { length: 128 }), // icon hash (build the CDN URL client-side, same as avatars)
  memberCount: int("member_count"),
  /** Staff opt-in. FALSE until a human ticks it - see the "discovery is not consent" note above. */
  managed: boolean("managed").default(false).notNull(),
  /** If true, CITADEL skips every member in this guild. The mapping stays visible, the writes do not
   * happen. This is the per-server "do not sync anyone here" override. */
  syncExemptAll: boolean("sync_exempt_all").default(false).notNull(),
  /** Does the bot hold the `Manage Roles` permission in this guild? Cached so the UI can explain a
   * guild that cannot be synced BEFORE someone toggles it and waits for a confusing 50013. */
  botCanManageRoles: boolean("bot_can_manage_roles").default(false).notNull(),
  /** Does the bot hold `Manage Nicknames`? A separate Discord permission from Manage Roles - a bot
   * can legitimately have one and not the other, and the failure modes are different. */
  botCanManageNicknames: boolean("bot_can_manage_nicknames").default(false).notNull(),
  /** Position of the bot's highest role. Discord forbids acting on any role at or ABOVE this, so
   * it is the hierarchy ceiling every mapped role is checked against (see citadelDiscordRoles). */
  botHighestRolePosition: int("bot_highest_role_position"),
  /** The guild owner's snowflake. Discord refuses a nickname change on the owner even for an admin
   * bot - cached so the engine can skip that member cleanly instead of failing forever on a 50013. */
  ownerId: varchar("owner_id", { length: 32 }),
  /** True while the bot is currently in the guild. A guild it was kicked from is kept (so the
   * mapping rows survive a re-invite) but marked absent rather than silently vanishing from the UI. */
  botPresent: boolean("bot_present").default(true).notNull(),
  /**
   * WHICH CAD AGENCY THIS DISCORD SERVER BELONGS TO (2026-08-09, owner rule). A CAD agency id from
   * `lib/cad/agencies.ts` (`lspd` | `lssd` | `doj` | `da`), or NULL for a server that belongs to
   * no faction (the main GrandSide guild, a partner server, anything staff-only).
   *
   * ⚠⚠ DEAD SINCE 2026-08-20. NOTHING READS THIS COLUMN. The permission boundary it used to carry
   * moved to `citadel_cad_guilds` (a row = this server belongs to this agency), because the owner
   * decided one server may serve SEVERAL agencies and a single varchar cannot say that. Migration
   * 0070 backfilled every non-null value into the new table; the column is kept on disk rather than
   * dropped because dropping data is the owner's call, not an agent's.
   *
   * ⚠ DO NOT "FIX" A SURFACE BY READING IT AGAIN. It is frozen at its 2026-08-20 value and will
   * drift the moment anyone binds or unbinds a server, so a reader gets an answer that looks
   * plausible and is stale - the worst shape of wrong. Read `cadAgenciesByGuild` (cadGuilds.ts).
   *
   * Nullable + no FK on purpose: agencies live in TypeScript (separate Lua/Next VMs, see agencies.ts),
   * so a retired agency id must degrade to "matches nobody" rather than break the guild row.
   */
  cadAgency: varchar("cad_agency", { length: 32 }),
  firstSeen: createdNow("first_seen"),
  updatedAt: createdNow("updated_at"), // app-maintained; refreshed on each discovery pass
}, (t) => [index("idx_discord_guilds_cad_agency").on(t.cadAgency)]);

/**
 * Global Discord sync exemptions - the current deny list for role writes and nickname sync.
 *
 * One row per Discord snowflake. The sync engine treats presence here as "never touch this user",
 * regardless of the guild. Guild-wide exemptions live on citadel_discord_guilds.sync_exempt_all.
 */
export const citadelDiscordSyncExemptions = mysqlTable(
  CT.discordSyncExemptions,
  {
    discordId: varchar("discord_id", { length: 32 }).primaryKey(),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
);

/**
 * Role cache per guild - the mapping editor's picker (nobody should hand-paste a snowflake), and
 * the hierarchy record. Refreshed by the same discovery pass as the guilds. Purely a CACHE: the
 * sync engine reads the LIVE role from discord.js, never this, so a stale row can mislead a human
 * but can never cause a wrong write.
 */
export const citadelDiscordRoles = mysqlTable(
  CT.discordRoles,
  {
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    roleId: varchar("role_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    color: int("color"), // Discord's integer colour; 0 = "no colour" (inherit), not black
    position: int("position").notNull(),
    /** Discord-managed roles (bot roles, booster role, integration roles) CANNOT be assigned by
     * anyone - the API rejects it. Cached so the picker can refuse to map one up front. */
    integrationManaged: boolean("integration_managed").default(false).notNull(),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.roleId] })],
);

/**
 * THE mapping - a staff rank grants these Discord roles. Read as: "a member whose staff rank is
 * `rankId` should hold `roleId` in `guildId`, and should NOT hold any other role in this table."
 *
 * `rankId` is a staff_ranks.id (`support|mod|supermod|admin|superadmin`) - a GAME-owned value we
 * reference by id but never constrain with an FK (cross-zone FKs would let CITADEL's migrations
 * fail on the game's data; the ownership split in §4 forbids it). A mapping whose rank no longer
 * exists is inert, and the UI shows it as unknown rather than crashing.
 *
 * Explicit per rank, NOT inherited by level: mapping `admin` does not implicitly give `superadmin`
 * that role. Rank hierarchy governs who may ACT on whom; it is deliberately not a role-grant graph,
 * because "Fondateur silently holds every lower rank's Discord role" is a surprise nobody asked for.
 * Map a role to several ranks if that is what you want - the UNIQUE is on the triple.
 */
export const citadelDiscordRankRoles = mysqlTable(
  CT.discordRankRoles,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    rankId: varchar("rank_id", { length: 32 }).notNull(), // staff_ranks.id - see note above on FKs
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    roleId: varchar("role_id", { length: 32 }).notNull(),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    uniqueIndex("uq_rank_role").on(t.rankId, t.guildId, t.roleId),
    // The sync engine's hot read is "every managed role in this guild" (to compute what to strip).
    index("idx_rank_roles_guild").on(t.guildId),
  ],
);

/**
 * Channel cache per guild - the composer's channel picker, and the "can the bot speak here" record.
 *
 * Same contract as citadelDiscordRoles above: purely a CACHE, refreshed by the discovery pass and by
 * the channel gateway events. Nothing reads it to decide what to DO - the send handler resolves the
 * live channel from discord.js and lets Discord be the authority - so a stale row can mislead a
 * human but can never cause a write into the wrong place.
 *
 * ⚠ `botCanSend` / `botCanRead` are the reason this table carries more than names. Discord answers a
 * missing permission with a 50001/50013 at SEND time, which in this architecture means: the staff
 * member writes an announcement, presses send, the panel says "en file", and the failure surfaces
 * minutes later in a job row nobody is watching. Caching the answer lets the picker grey the channel
 * out with a reason BEFORE the message is written. It is advisory, never a gate: the handler still
 * attempts the send and reports Discord's real verdict.
 */
export const citadelDiscordChannels = mysqlTable(
  CT.discordChannels,
  {
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    /** Discord's numeric ChannelType (0 text, 2 voice, 4 category, 5 announcement, 15 forum, 11/12
     *  thread…). Stored raw rather than as an enum: Discord adds types, and an unknown number should
     *  degrade to "not offered in the picker", never to a failed insert. */
    type: int("type").notNull(),
    /** Owning category, or the parent channel of a thread. Lets the picker group like Discord does. */
    parentId: varchar("parent_id", { length: 32 }),
    position: int("position").notNull().default(0),
    /** ViewChannel + SendMessages (+ SendMessagesInThreads on a thread) for the bot, right now. */
    botCanSend: boolean("bot_can_send").default(false).notNull(),
    /** ViewChannel + ReadMessageHistory - what IMPORTING an existing message needs. Separate from
     *  botCanSend because they genuinely come apart: a locked announcement channel is often readable
     *  and not writable, and an import-only failure needs its own explanation. */
    botCanRead: boolean("bot_can_read").default(false).notNull(),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    // The picker's only query shape: every channel in one guild, ordered.
    index("idx_discord_channels_guild").on(t.guildId, t.position),
  ],
);

/**
 * THE composer's store - one row per message staff wrote for the bot to say in a channel.
 *
 * WHY A TABLE AND NOT A FIRE-AND-FORGET JOB. The owner asked for three things and only the first is
 * a send: "send messages in any channel … modify that message later … get the message text and
 * resend". The last two need the message to still EXIST somewhere after it has left, because
 * Discord's edit endpoint takes a (channel id, message id) pair and nothing else in CITADEL would
 * remember it. So the row is the durable object; `citadel_jobs` is only the transport.
 *
 * ⚠ `botAuthored` DECIDES WHETHER EDIT IS EVEN POSSIBLE, and it is not a preference. Discord lets a
 * bot edit ONLY its own messages - PATCH on anyone else's is a hard 50005 ("Cannot edit a message
 * authored by another user"), with no permission that unlocks it. So an IMPORTED message (the
 * "get the message text" path, which can point at any message the bot can read) is read-only by
 * construction, and the honest UI affordance for it is "duplicate and send a new one", not an edit
 * button that always fails. The column exists so that decision is made from a fact rather than from
 * a guess about where the row came from.
 *
 * ⚠ WHY A BOT IS NOT A WEBHOOK, and the one feature that does not carry over: a webhook can override
 * `username` and `avatar_url` per message, which is how Discohook makes one webhook look like many
 * senders. A BOT cannot - every message is from the bot's own identity. Everything else (content,
 * up to 10 embeds, allowed_mentions) is identical, and a bot gains edit/delete of its own messages,
 * which a webhook only has via its own token. Nothing here should try to emulate the username
 * override; there is no API for it.
 *
 * `dirty` is explicit rather than an `updatedAt > syncedAt` comparison: these are second-granularity
 * MariaDB datetimes, so a save-then-publish inside the same second would compare equal and silently
 * report "published" while Discord still shows the old text.
 */
export const citadelDiscordMessages = mysqlTable(
  CT.discordMessages,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    /** Discord's id for the LIVE message. Null until it has actually been sent (or imported). It is
     *  the ONLY handle an edit or a delete can use - losing it makes a sent message unmanageable. */
    discordMessageId: varchar("discord_message_id", { length: 32 }),
    /** False for a message the bot did not write. See the 50005 note above - this gates edit/delete. */
    botAuthored: boolean("bot_authored").default(true).notNull(),
    /** Staff-facing label for the list. Never sent to Discord. */
    title: varchar("title", { length: 160 }).notNull(),
    /** The plain message body (Discord's `content`), up to 2000 chars. May be empty when the message
     *  is embeds-only - Discord accepts that, and it is the normal shape for an announcement. */
    content: text("content"),
    /** Normalized embed array, exactly the shape Discord's API takes. Validated on every write by
     *  lib/data/discordMessages.ts - never trusted from the client, since the composer also accepts
     *  pasted JSON. */
    embeds: json("embeds"),
    /** allowed_mentions toggles: { everyone, roles, users }. ⚠ DEFAULTS TO ALL FALSE and that is the
     *  point - an @everyone typed into a draft in an announcement channel otherwise pings the whole
     *  community the first time someone presses send to "see what it looks like". */
    allowMentions: json("allow_mentions"),
    status: mysqlEnum("status", ["draft", "queued", "sent", "failed"]).default("draft").notNull(),
    /** True when the row has unpublished local edits. Cleared by a successful send/edit/import. */
    dirty: boolean("dirty").default(true).notNull(),
    /** Discord's own words for the last failure - shown next to the row, not buried in the queue. */
    lastError: varchar("last_error", { length: 512 }),
    /** citadel_jobs.id of the in-flight (or last) job, so the UI can follow it to completion. */
    lastJobId: bigint("last_job_id", { mode: "number" }),
    createdBy: bigint("created_by", { mode: "number" }),
    updatedBy: bigint("updated_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
    sentAt: nullableDate("sent_at"),
    editedAt: nullableDate("edited_at"),
  },
  (t) => [
    // The list is "newest first", and the per-channel history view filters by channel.
    index("idx_discord_messages_channel").on(t.channelId, t.id),
    // Re-importing a message already tracked must find the existing row rather than fork a second one.
    index("idx_discord_messages_discord_id").on(t.discordMessageId),
  ],
);

/**
 * Bot liveness - the honest answer to "is the bot up?".
 *
 * Page 9 previously showed "Statut indisponible" and fell back to inferring life from queue
 * activity, which conflates "bot is down" with "queue is empty" - two very different situations
 * that look identical. The bot now beats a row here on an interval, so staleness is a real
 * reading. One row per bot instance (`id`), so a second instance is VISIBLE rather than quietly
 * double-processing.
 */
export const citadelBotHeartbeat = mysqlTable(CT.botHeartbeat, {
  /** Instance id - env BOT_INSTANCE_ID, default "default". Two rows = two bots running. */
  id: varchar("id", { length: 64 }).primaryKey(),
  botUserId: varchar("bot_user_id", { length: 32 }),
  botTag: varchar("bot_tag", { length: 64 }),
  guildCount: int("guild_count"),
  /** Gateway websocket ping in ms - the one number that says the connection is actually healthy
   * rather than merely that the process is alive. Negative/-1 from discord.js means "not measured". */
  wsPingMs: int("ws_ping_ms"),
  /** Whether this instance negotiated the privileged GuildMembers intent - i.e. whether live drift
   * revert is actually armed. Surfaced on Page 9 so "protected" is never claimed when it isn't. */
  guildMembersIntent: boolean("guild_members_intent").default(false).notNull(),
  startedAt: createdNow("started_at"),
  beatAt: createdNow("beat_at"), // app-maintained; the freshness clock
});

/**
 * ACTUAL Discord role membership - who holds which MANAGED role, right now, according to Discord.
 *
 * WHY THIS EXISTS (it is the missing primitive): every other table here records what CITADEL
 * *intends*. Nothing recorded what Discord *has*. That gap is why the panel could never answer the
 * questions an operator actually asks - "who holds Admin right now?", "is anyone holding a role
 * they shouldn't?", "how much of my staff is actually correct?" - and why the overview had nothing
 * real to put on it. The panel cannot ask Discord itself (no gateway, design §3), so the BOT
 * snapshots it here and the panel reads it.
 *
 * SCOPE IS DELIBERATELY NARROW: only roles present in citadel_discord_rank_roles, only in managed
 * guilds. This is NOT a mirror of the member list - mirroring every member's every role would be a
 * large, churning, privacy-relevant dataset we have no use for, and it would quietly turn CITADEL
 * into a Discord scraper. We record exactly the roles the engine may touch.
 *
 * A CACHE, not a source of truth: the sync engine always reads LIVE roles from discord.js before
 * acting (bot/handlers/syncMember.ts). A stale row here can mislead a human; it can never cause a
 * wrong write. `snapshotAt` is surfaced so the UI can say how fresh it is instead of implying live.
 */
export const citadelDiscordMemberRoles = mysqlTable(
  CT.discordMemberRoles,
  {
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    roleId: varchar("role_id", { length: 32 }).notNull(),
    /** When this row was last confirmed present by a snapshot - the freshness clock. */
    snapshotAt: createdNow("snapshot_at"),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.discordId, t.roleId] }),
    // "who holds this role" - the per-role count/holder list on the guild panel.
    index("idx_member_roles_role").on(t.guildId, t.roleId),
    // "what does this person hold" - the roster/drift join.
    index("idx_member_roles_member").on(t.discordId),
  ],
);

/* ── Discord voice presence ──────────────────────────────────────────────────
 *
 * WHY THESE EXIST: the F5 admin menu requires staff to be sitting in a voice channel of the
 * GrandSide guild (owner decision 2026-08-03). That fact lives ONLY inside Discord and arrives
 * over the gateway, which the bot holds - a different process from both the game server and the
 * web app. So the bot mirrors it here and the game reads the mirror.
 *
 * ⚠ THE MIRROR'S FAILURE MODE IS THE WHOLE DESIGN. `voiceState` carries no row for someone who is
 * not in voice, and it carries no row for someone the bot never heard about. Those two are the
 * same bytes and opposite meanings. A bot that dies mid-session leaves the table frozen: everyone
 * who happened to be in voice stays "present" forever and everyone else is locked out forever,
 * with nothing anywhere reporting a fault. `voiceSync` is the answer - a heartbeat the reader
 * checks BEFORE trusting an absence, so the game can distinguish "not in voice" from "we do not
 * currently know", and refuse in a way that names the reason. Never read voiceState without it.
 */

/**
 * LIVE voice occupancy. One row per person currently in a voice channel; deleted on leave.
 *
 * Rebuilt from scratch on every bot boot (bot/voice.ts reconcile pass) because `voiceStateUpdate`
 * reports CHANGES ONLY - a session that started before the bot connected produces no event, so a
 * listener-only mirror is permanently missing everyone who was already talking.
 */
export const citadelDiscordVoiceState = mysqlTable(
  CT.discordVoiceState,
  {
    discordId: varchar("discord_id", { length: 32 }).primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    /** Denormalised on purpose: a renamed or deleted channel must not rewrite history. */
    channelName: varchar("channel_name", { length: 128 }),
    /** True when this is the guild's designated AFK channel - parked is not present. */
    afk: boolean("afk").default(false).notNull(),
    selfMute: boolean("self_mute").default(false).notNull(),
    selfDeaf: boolean("self_deaf").default(false).notNull(),
    joinedAt: createdNow("joined_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    // "who is in this channel" - the co-occupant snapshot and the staff presence panel.
    index("idx_voice_state_channel").on(t.guildId, t.channelId),
  ],
);

/**
 * Append-only voice join/leave history, rendered on the player page.
 *
 * `occupants` is a SNAPSHOT, not a join. Who else was in the channel at that instant cannot be
 * recovered from any other row here afterwards, so it is captured at write time or it is lost.
 * Same reasoning as `channelName`: this table records what was true then, not what is true now.
 */
export const citadelDiscordVoiceEvents = mysqlTable(
  CT.discordVoiceEvents,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    /** `move` is a leave and a join in one gateway event; recording it as two would invent a gap. */
    action: mysqlEnum("action", ["join", "leave", "move"]).notNull(),
    channelId: varchar("channel_id", { length: 32 }),
    channelName: varchar("channel_name", { length: 128 }),
    /** Populated only for `move` - the channel they came FROM. */
    fromChannelId: varchar("from_channel_id", { length: 32 }),
    fromChannelName: varchar("from_channel_name", { length: 128 }),
    /** [{ discordId, name }] - everyone ELSE in the channel at this moment. Never the subject. */
    occupants: json("occupants"),
    occupantCount: int("occupant_count").default(0).notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    // The player page: this person's history, newest first.
    index("idx_voice_events_member").on(t.discordId, t.id),
    // "who was in this channel around time T" - the forensic direction.
    index("idx_voice_events_channel").on(t.guildId, t.channelId, t.id),
  ],
);

/**
 * FRESHNESS CLOCK - one row per guild, rewritten by the bot on a fixed interval.
 *
 * ⚠ `beatAt` is what makes an ABSENCE in citadel_discord_voice_state meaningful. A reader that
 * skips it cannot tell a quiet channel from a dead bot, and will fail in the permissive direction
 * exactly when the mechanism has stopped working. `lastFullSyncAt` records the boot reconcile, so
 * a mirror that has never been reconciled in this process is visibly untrustworthy.
 */
export const citadelDiscordVoiceSync = mysqlTable(CT.discordVoiceSync, {
  guildId: varchar("guild_id", { length: 32 }).primaryKey(),
  beatAt: createdNow("beat_at"),
  lastFullSyncAt: nullableDate("last_full_sync_at"),
  /** Occupancy at the last beat - lets a human sanity-check the mirror without a second query. */
  trackedCount: int("tracked_count").default(0).notNull(),
});

/**
 * Live session map - which FiveM server-id is which account, right now.
 *
 * gs_citadel writes one row per connected player (it already resolves identifiers at connect) and
 * deletes it on drop / clears all on resource restart. This is the RELIABLE server-id → identity
 * source: FiveM's players.json `identifiers` array is frequently empty, so it can't be trusted to
 * map a live slot to a license. Presence enrichment joins this to `users` (RP name) and
 * citadel_discord_users (@username), and merges players.json only for the live ping.
 */
export const citadelOnline = mysqlTable(
  CT.online,
  {
    serverId: int("server_id").primaryKey(), // the FiveM slot id - unique while connected
    accountId: bigint("account_id", { mode: "number" }),
    license: varchar("license", { length: 128 }), // bare hex - joins users.identifier
    discordId: varchar("discord_id", { length: 32 }),
    // Raw connect name - fallback/debug ONLY, never shown (it is the Steam/FiveM username).
    playerName: varchar("player_name", { length: 100 }),
    joinedAt: createdNow("joined_at"),
    // Live world position - sampled SERVER-SIDE via OneSync by gs_citadel (never client-reported), so
    // /staff/map can plot real players. Null until the first sample lands. `positionAt` lets the map
    // dim/drop a stale dot if the sampler stops.
    x: float("x"),
    y: float("y"),
    heading: float("heading"),
    positionAt: nullableDate("position_at"),
    vehiclePlate: varchar("vehicle_plate", { length: 32 }),
    vehicleSeat: int("vehicle_seat"),
    vehicleAt: nullableDate("vehicle_at"),
    // Live account balances, sampled SERVER-SIDE by CITADEL (live_accounts.lua) so the player profile
    // shows real-time money for an ONLINE player instead of the stale persisted users.accounts (ESX only
    // flushes that periodically / on disconnect). bigint: ESX balances can exceed int32. Null until the
    // first sample; accountsAt lets the web fall back to the DB value when the sampler stopped (a game
    // crash without a clean drop) - freshness is checked DB-side so no web/DB clock-skew bug.
    cash: bigint("cash", { mode: "number" }),
    bank: bigint("bank", { mode: "number" }),
    black: bigint("black", { mode: "number" }),
    chips: bigint("chips", { mode: "number" }),
    accountsAt: nullableDate("accounts_at"),
  },
  (t) => [index("idx_citadel_online_vehicle_plate").on(t.vehiclePlate)],
);

/**
 * LIVE CARRIED BELONGINGS - what a CONNECTED player has in their pockets right now.
 *
 * Written ONLY by the game (CITADEL/server/live_belongings.lua), read only here. Same inverted
 * ownership as citadelWeaponCatalog / citadelCadPresence: CITADEL migrates it, the game fills it.
 *
 * ⚠ THIS IS NOT A DUPLICATE OF `users.inventory` - it is the part that column cannot express.
 * `users.inventory` is a PERIODIC FLUSH (es_extended Config.SaveInterval, plus playerDropped); it is
 * correct about a player who is offline and arbitrarily stale about one who is not. Measured on
 * production 2026-08-24: the worst row for a then-connected player was 41.9 hours behind the live
 * xPlayer. Readers must therefore prefer this table for an online player and fall back to
 * `users.inventory` when there is no row - see lib/data/inventory.ts, which does exactly that and
 * labels which of the two it used rather than blending them silently.
 *
 * ⚠ ABSENT ROW MEANS "NOT ONLINE", AND THAT IS LOAD-BEARING. The writer sweeps rows for licenses it
 * no longer sees each tick, so absence is a positive statement, not a gap. It must never be read as
 * "this player carries nothing": the honest answer for an offline player is the persisted column.
 * `sampledAt` is the freshness clock for the other failure mode - the sampler stopping while players
 * stay connected (a crashed thread), where the row would otherwise freeze and look live forever.
 */
export const citadelOnlineBelongings = mysqlTable(CT.onlineBelongings, {
  // Bare hex, joins users.identifier. varchar(128) to match citadelOnline.license exactly - these two
  // are read together and a width/collation mismatch is the classic silent-empty-join bug here.
  license: varchar("license", { length: 128 }).primaryKey(),
  // The FiveM slot at sample time. Debug/correlation only - never an identity (it is reused the
  // moment the player disconnects). License is the identity.
  serverId: int("server_id"),
  // JSON array, the compact shape gs_base's belongings snapshot already emits: [{n,c,l}] for items
  // (name, count, label) and [{n,a,s}] for weapons (name, ammo, serial). Deliberately the SAME shape
  // as gs_logs.data.snapshot.players[].items/weapons so one parser serves both surfaces.
  items: text("items"),
  weapons: text("weapons"),
  // Denormalised so a list view can show "24 objets" without parsing two blobs per row.
  itemCount: int("item_count"),
  weaponCount: int("weapon_count"),
  // Carried weight against the player's own cap (ESX Config.MaxWeight plus any donator bonus), so the
  // panel can show a real fill bar rather than recomputing from item weights it may not have.
  weight: float("weight"),
  maxWeight: float("max_weight"),
  // Change key over (items, weapons). The writer skips the UPDATE when it is unchanged, which is what
  // keeps this table cheap: a player standing still costs one read and no write. It is ALSO the diff
  // poller's signal (lib/realtime/belongings.ts) - the poller compares hashes, so it never has to pull
  // the blobs just to find out whether anything moved.
  contentHash: varchar("content_hash", { length: 64 }),
  // When the sampler last LOOKED (refreshed every tick, even when nothing changed). Freshness clock:
  // distinguishes "nothing has moved" from "the sampler died". Not the same as when it last CHANGED.
  sampledAt: createdNow("sampled_at"),
});

/* ── Identity graph (LINK, DON'T MERGE - design §6) ──────────────────────────── */

export const citadelAccounts = mysqlTable(CT.accounts, {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  displayName: varchar("display_name", { length: 64 }),
  notes: text("notes"),
  createdAt: createdNow("created_at"),
});

export const identifierTypes = [
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

export const citadelIdentifiers = mysqlTable(
  CT.identifiers,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    type: mysqlEnum("type", identifierTypes).notNull(),
    value: varchar("value", { length: 128 }).notNull(),
    firstSeen: createdNow("first_seen"),
    lastSeen: createdNow("last_seen"),
    // first_seen + session_count distinguish "once on a brother's PC" from "daily" - they ARE the review.
    sessionCount: int("session_count").default(1).notNull(),
  },
  (t) => [
    uniqueIndex("uq_identifier").on(t.type, t.value), // the connect-time lookup index
    index("idx_identifier_account").on(t.accountId),
  ],
);

export const citadelAccountLinks = mysqlTable(
  CT.accountLinks,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountA: bigint("account_a", { mode: "number" }).notNull(),
    accountB: bigint("account_b", { mode: "number" }).notNull(),
    strength: mysqlEnum("strength", ["strong", "medium", "weak"]).notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["flagged", "confirmed", "dismissed"])
      .default("flagged")
      .notNull(),
    firstSeen: createdNow("first_seen"),
    lastSeen: createdNow("last_seen"),
    reviewedBy: bigint("reviewed_by", { mode: "number" }),
    reviewedAt: nullableDate("reviewed_at"),
  },
  (t) => [uniqueIndex("uq_link_pair").on(t.accountA, t.accountB)],
);

// "Verified brothers, same PC" - stops flagging AND ban propagation for the pair, permanently.
export const citadelLinkExemptions = mysqlTable(
  CT.linkExemptions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountA: bigint("account_a", { mode: "number" }).notNull(),
    accountB: bigint("account_b", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    approvedBy: bigint("approved_by", { mode: "number" }).notNull(),
    approvedAt: createdNow("approved_at"),
  },
  (t) => [uniqueIndex("uq_exemption_pair").on(t.accountA, t.accountB)],
);

/* ── IP intelligence (VPN gate cache - fails OPEN, design §8) ────────────────── */

export const citadelIpIntel = mysqlTable(CT.ipIntel, {
  ip: varchar("ip", { length: 45 }).primaryKey(),
  verdict: mysqlEnum("verdict", ["allow", "block"]).notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  fraudScore: int("fraud_score"),
  isVpn: boolean("is_vpn").default(false).notNull(),
  isProxy: boolean("is_proxy").default(false).notNull(),
  isTor: boolean("is_tor").default(false).notNull(),
  isHosting: boolean("is_hosting").default(false).notNull(),
  raw: json("raw"),
  checkedAt: createdNow("checked_at"),
});

export const citadelIpExemptions = mysqlTable(CT.ipExemptions, {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  ip: varchar("ip", { length: 45 }),
  accountId: bigint("account_id", { mode: "number" }),
  reason: varchar("reason", { length: 255 }).notNull(),
  approvedBy: bigint("approved_by", { mode: "number" }).notNull(),
  approvedAt: createdNow("approved_at"),
});

/* ── Job queue (ALL Discord + game writes - never inline in a request) ───────── */

export const citadelJobs = mysqlTable(
  CT.jobs,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    kind: varchar("kind", { length: 64 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["queued", "running", "done", "failed", "dead"])
      .default("queued")
      .notNull(),
    runAt: createdNow("run_at"),
    attempts: int("attempts").default(0).notNull(),
    maxAttempts: int("max_attempts").default(5).notNull(),
    lastError: text("last_error"),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_jobs_claim").on(t.status, t.runAt)],
);

/* ── Notifications (the table is the record; SSE is transport - design §10) ──── */

export const citadelNotifications = mysqlTable(
  CT.notifications,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    recipientAccountId: bigint("recipient_account_id", { mode: "number" }).notNull(),
    tier: mysqlEnum("tier", ["critical", "alert", "info"]).notNull(),
    topic: varchar("topic", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    href: varchar("href", { length: 255 }),
    readAt: nullableDate("read_at"),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_notif_recipient").on(t.recipientAccountId, t.readAt)],
);

/* ── Uploads (control plane ONLY - bytes never transit Node, design §9) ──────── */

export const citadelUploads = mysqlTable(CT.uploads, {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  objectKey: varchar("object_key", { length: 255 }).notNull().unique(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  mime: varchar("mime", { length: 128 }).notNull(),
  sha256: varchar("sha256", { length: 64 }),
  status: mysqlEnum("status", ["pending", "active", "quarantined", "removed"])
    .default("pending")
    .notNull(),
  moderatedBy: bigint("moderated_by", { mode: "number" }),
  moderatedAt: nullableDate("moderated_at"),
  createdAt: createdNow("created_at"),
});

/** Single-use bearer tokens for the game-side upload leg (2026-07-26, gcphone photo uploads - the
 * first producer). The game CLIENT uploads bytes directly to /api/game/photo-upload via
 * screenshot-basic's multipart POST, and a client can never HMAC-sign (it doesn't construct the
 * request), so a short-lived random token minted by the HMAC-authenticated
 * /api/game/photo-upload-ticket route stands in as its bearer credential instead. Consumed (deleted)
 * on first successful upload; a background sweep (or the route itself) prunes expired-but-unused
 * rows. `uploadId` points at the PENDING citadel_uploads row the ticket mint already created. */
export const citadelUploadTickets = mysqlTable(CT.uploadTickets, {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  uploadId: bigint("upload_id", { mode: "number" }).notNull(), // FK citadel_uploads.id
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  createdAt: createdNow("created_at"),
});

/* ── Audit (panel is LOGGED context, never an authorization input) ───────────── */

export const citadelAudit = mysqlTable(
  CT.audit,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    actorAccountId: bigint("actor_account_id", { mode: "number" }),
    actorRank: varchar("actor_rank", { length: 32 }),
    panel: varchar("panel", { length: 32 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 128 }),
    reason: varchar("reason", { length: 255 }),
    data: json("data"),
    ip: varchar("ip", { length: 45 }),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    index("idx_audit_actor").on(t.actorAccountId),
    index("idx_audit_action").on(t.action),
    index("idx_audit_created").on(t.createdAt),
  ],
);

/* ── Config (CITADEL-owned toggles - every write audited) ────────────────────── */

export const citadelConfig = mysqlTable(CT.config, {
  k: varchar("k", { length: 64 }).primaryKey(),
  v: text("v"),
  updatedBy: bigint("updated_by", { mode: "number" }),
  updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
});

/**
 * Saved staff page layouts.
 *
 * One row per viewer account and page key. The payload stays generic so the same table can back
 * the player hub today and any other reorderable staff surface later.
 */
export const citadelUiLayouts = mysqlTable(
  CT.uiLayouts,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    pageKey: varchar("page_key", { length: 96 }).notNull(),
    layout: json("layout").$type<{ order: string[] }>().notNull(),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    uniqueIndex("uq_ui_layouts_account_page").on(t.accountId, t.pageKey),
    index("idx_ui_layouts_account").on(t.accountId),
  ],
);

/* ── Reports ─────────────────────────────────────────────────────────────────── */

export const citadelReports = mysqlTable(
  CT.reports,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * How the report arrived.
     *
     * ⚠ CORRECTED 2026-07-16 BY THE OWNER - this column used to also carry `discord`, on the theory
     * that "a ticket and a report are the same object (open → claim → thread → resolve)". They are
     * NOT, and that merge was a previous session's inference, never the owner's decision:
     *   REPORT  = the in-game /report. "Ce joueur fait du RDM." Short, urgent, staff comes and looks.
     *   TICKET  = Discord support. Typed (!deban/!mortrp/!register/!dossier/!candidature), threaded, `!close`,
     *             a player-quotable ref, and it lives for days.
     * Same four status words, completely different lifecycle, audience and urgency. Tickets now live
     * in `citadel_tickets` - see schema below and CITADEL_TICKETS_DIVISIONS.md §3.
     *
     * `discord` is kept in the enum ONLY so historical rows written under the old model still read
     * back; nothing writes it any more.
     */
    source: mysqlEnum("source", ["ingame", "web", "discord"]).default("ingame").notNull(),
    reporterAccountId: bigint("reporter_account_id", { mode: "number" }),
    reporterIdentifier: varchar("reporter_identifier", { length: 60 }),
    reportedIdentifier: varchar("reported_identifier", { length: 60 }),
    /**
     * The DM'ing snowflake. NOT derivable from reporterAccountId, which is exactly why it exists:
     * owner decision (2026-07-16) is to ACCEPT tickets from unlinked users, so an unlinked ticket
     * has no account and no license - this column is then the ONLY way to reply to the player.
     * Also stays correct if the account is later relinked to a different Discord.
     */
    reporterDiscordId: varchar("reporter_discord_id", { length: 32 }),
    message: text("message").notNull(),
    priority: tinyint("priority").default(0).notNull(),
    status: mysqlEnum("status", ["open", "claimed", "resolved", "closed"])
      .default("open")
      .notNull(),
    claimedBy: bigint("claimed_by", { mode: "number" }),
    resolvedBy: bigint("resolved_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_reports_status").on(t.status)],
);

export const citadelReportMessages = mysqlTable(
  CT.reportMessages,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reportId: bigint("report_id", { mode: "number" }).notNull(),
    authorAccountId: bigint("author_account_id", { mode: "number" }),
    authorKind: mysqlEnum("author_kind", ["staff", "player", "system"]).notNull(),
    body: text("body").notNull(),
    /**
     * DM delivery state for a staff reply on a `discord`-source ticket. `na` = this message was
     * never meant to leave CITADEL (an in-game/web report, or the player's own inbound message).
     *
     * ⚠ WHY THIS COLUMN EXISTS: a staff reply is enqueued as a job and delivered by a separate
     * process, so it can FAIL after the panel already showed the message as sent - most commonly
     * error 50007 (the player has DMs closed, or left the guild). Without a delivery state that is
     * invisible: staff believe they answered, the player hears nothing, and the ticket rots while
     * both sides wait for the other. Page 3 renders this per message.
     */
    deliveryStatus: mysqlEnum("delivery_status", ["na", "pending", "sent", "failed"])
      .default("na")
      .notNull(),
    deliveryError: varchar("delivery_error", { length: 255 }),
    /**
     * The name the DM was actually signed with - the staff member's RP name + rank, or "MP STAFF"
     * when it was withheld (owner rule 2026-07-16: names show UNLESS the player is banned).
     * Recorded because what the PLAYER SAW is not reconstructable later: the rule's input (is this
     * player banned) changes over time, so replaying it against today's ban state would answer a
     * different question than the one asked at send time. It is also the only way to adjudicate
     * "staff member X told me Y" months on.
     */
    deliveredAs: varchar("delivered_as", { length: 64 }),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_report_messages_report").on(t.reportId)],
);

/* ── TICKETS - the Discord support system (TASEv3 replacement) ────────────────────────────────
 *
 * A TICKET IS NOT A REPORT. Owner decision 2026-07-16, correcting a previous session's merge:
 *   REPORT  (citadel_reports)  = in-game /report. Short, urgent, transient.
 *   TICKET  (here)             = Discord support. Typed, threaded, days long, player-quotable ref.
 * They share four status words and nothing else that matters - different lifecycle, audience,
 * urgency and page. Merging them meant a `!deban` and "ce mec fait du RDM" landed in one queue.
 *
 * INTAKE WAS DISCORD-ONLY, AND IS NO LONGER (owner decision 2026-07-17). A second door opened -
 * staff create a ticket from the panel and add players to it - so the column this comment once
 * said would never be earned now exists: `origin`. There is still no web form and no in-game
 * command; the two doors are the bot's DM and a staff member's hand.
 *
 * A TICKET NOW HAS A SET OF PLAYERS, NOT ONE. See citadel_ticket_participants: staff can add
 * several people to one ticket and every message fans out to all the others, so they hold a
 * conversation through the bot (Discord bots CANNOT create group DMs - that is a platform
 * restriction, so the group chat is BUILT out of N 1:1 DMs, not obtained).
 *
 * Full design: fivem/server-data/_server_build/CITADEL_TICKETS_DIVISIONS.md §3.
 */

export const citadelTickets = mysqlTable(
  CT.tickets,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * The short, player-quotable id the bot puts in every DM ("ID du ticket : #OT9").
     * NOT derived from `id`: that would leak total ticket volume to every player, and it must stay
     * stable if rows are ever re-keyed. The prefix encodes the type, so a player quoting "#RE9"
     * tells staff what it is before anything is opened.
     */
    publicRef: varchar("public_ref", { length: 12 }).notNull(),
    /**
     * What the player asked for - the bot's `!deban` / `!mortrp` / `!register` / `!dossier` / `!candidature` /
     * `!ticket` menu. Not a label: it decides which DIVISION owns the ticket (and therefore who may
     * see it), and which context the page loads beside the thread. Defs in lib/data/ticketTypes.ts.
     */
    type: mysqlEnum("type", ["deban", "mortrp", "register", "dossier", "candidature", "other"])
      .default("other")
      .notNull(),
    /**
     * The owning division (staff_divisions.id), or NULL for the general queue.
     *
     * ⚠ AN ACL, NOT A TAG - owner decision: a division ticket is PRIVATE to that division + the
     * Fondateur. Enforced in the QUERY, in the SSE hub, and in the notification routing (all three
     * are independent read paths). Deliberately NOT a foreign key: staff_divisions is game-owned
     * (gs_utils CREATEs it) and cross-zone FKs are forbidden by the ownership split - same reason
     * citadel_discord_rank_roles references staff_ranks.id by value.
     */
    divisionId: varchar("division_id", { length: 32 }),
    /**
     * Which door this ticket came through.
     *
     * The DB default is `discord` FOR THE BACKFILL ONLY - every row that predates 2026-07-17 came
     * through the bot. ⚠ Drizzle makes a defaulted column OPTIONAL in the insert type, so the
     * compiler will NOT make you say which door a new ticket came through; it will quietly say
     * `discord`. Both writers (openTicket, createStaffTicket) state it explicitly anyway. Any third
     * one must too - a staff-created ticket silently typed `discord` gets a cooldown and an opener
     * it should not have.
     *
     * This is the column the header above once argued a ticket could never earn ("a column that is
     * always one value is a lie waiting to be believed"). That was true while the bot's DM was the
     * only door. Staff-created tickets are the second value, so it stopped being a lie.
     */
    origin: mysqlEnum("origin", ["discord", "staff"]).default("discord").notNull(),
    /** The identity-graph account, when the Discord is linked. NULL = unlinked (accepted - see below). */
    openerAccountId: bigint("opener_account_id", { mode: "number" }),
    /**
     * The snowflake that OPENED this ticket by DMing the bot. PROVENANCE, not an address.
     *
     * ⚠ WAS NOT NULL UNTIL 2026-07-17, and the invariant it carried ("the ONLY way to reply") is
     * REAL but no longer lives here - it moved to citadel_ticket_participants.discord_id, which is
     * NOT NULL, because a ticket now has a SET of DM-able people rather than one. Never resolve a
     * DM recipient from this column: on a group ticket it names one participant out of several,
     * and on a staff-created ticket it is NULL because nobody opened it.
     *
     * Invariant, enforced in openTicket()/createStaffTicket(), not by the DB:
     *     origin = 'discord'  ->  opener_discord_id IS NOT NULL
     *     origin = 'staff'    ->  opener_discord_id IS NULL
     *
     * It is still load-bearing for one thing: the open COOLDOWN is keyed on it, so a NULL opener
     * means a staff-created ticket structurally cannot charge a player a cooldown they did not
     * spend. That falls out for free rather than needing a special case.
     */
    openerDiscordId: varchar("opener_discord_id", { length: 32 }),
    /**
     * Optional short staff title for the ticket. Visual shorthand only, never an ACL.
     *
     * Shown alongside the person the ticket is about so a custom title does not erase who the
     * thread belongs to.
     */
    title: varchar("title", { length: 120 }),
    /**
     * The character the ticket is ABOUT (bare-hex license), chosen by the player when the identity
     * graph found several on their Discord - the TASEv3 "[1] … [2] …" picker. NULL when they have
     * exactly one character, none yet, or when staff created the ticket (there is no single subject
     * on a group ticket - each participant carries their own, see participants.subject_identifier).
     *
     * ⚠ Bare-hex license. NEVER join it column-to-column against the game's `users.identifier`:
     * citadel_* is utf8mb4_general_ci and ESX `users` is utf8mb4_unicode_ci, so a JOIN throws
     * "Illegal mix of collations" at RUNTIME, not at build. Resolve per-id with a bound parameter.
     */
    subjectIdentifier: varchar("subject_identifier", { length: 60 }),
    priority: tinyint("priority").default(0).notNull(),
    status: mysqlEnum("status", ["open", "claimed", "resolved", "closed"])
      .default("open")
      .notNull(),
    claimedBy: bigint("claimed_by", { mode: "number" }),
    resolvedBy: bigint("resolved_by", { mode: "number" }),
    /** 1 = the player closed it themselves with `!close`. A different question from `status`. */
    closedByPlayer: tinyint("closed_by_player").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    index("idx_tickets_status").on(t.status),
    // The ACL predicate is on every queue read - `division_id IS NULL OR division_id IN (...)`.
    index("idx_tickets_division").on(t.divisionId),
    // Was the bot's inbound hot path ("does this snowflake already have an open ticket?"); that
    // question now goes through citadel_ticket_participants, since a player can be on a ticket
    // they did not open. Still earns its keep: the open COOLDOWN is keyed on this column.
    index("idx_tickets_opener").on(t.openerDiscordId),
    // Players quote "#OT9"; the ⌘K palette and the bot both look it up.
    uniqueIndex("uq_tickets_public_ref").on(t.publicRef),
  ],
);

/**
 * WHICH staff members are assigned to this ticket.
 *
 * `claimedBy` stays the primary owner for the queue, but assignment is now a separate set so a
 * ticket can be shared across several staff without turning "who owns it" into "who may speak".
 * A ticket reply is allowed for the primary claim owner or any active assignee.
 */
export const citadelTicketStaffAssignments = mysqlTable(
  CT.ticketStaffAssignments,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    addedBy: bigint("added_by", { mode: "number" }).notNull(),
    addedAt: createdNow("added_at"),
    leftAt: nullableDate("left_at"),
  },
  (t) => [
    index("idx_ticket_staff_assignments_ticket").on(t.ticketId),
    index("idx_ticket_staff_assignments_account").on(t.accountId),
    uniqueIndex("uq_ticket_staff_assignment").on(t.ticketId, t.accountId),
  ],
);

/**
 * One message in a ticket thread.
 *
 * ⚠ THE THREE `delivery_*` COLUMNS LIVED HERE UNTIL 2026-07-17 and are now in
 * citadel_ticket_deliveries, one row per RECIPIENT. They were not moved for tidiness: fan-out
 * means one message has N independent outcomes (A's DMs are open, B's are closed = 50007), and
 * `delivered_as` is *structurally* per-recipient - the name rule's input is "is THIS RECIPIENT
 * banned", so one message legitimately goes out signed "Jean Dupont · Modérateur" to A and
 * "MP STAFF" to banned B. As scalars they were only ever correct because N was always 1.
 *
 * citadel_report_messages KEEPS its scalars and must not be touched: a report has exactly one
 * reporter, forever, and the legacy {reportId, messageId} job shape still reads them.
 */
export const citadelTicketMessages = mysqlTable(
  CT.ticketMessages,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    /**
     * The staff account that wrote it, or the player's account when their Discord is linked.
     * Meaningful for `staff` always; for `player` it is a convenience and MAY be NULL (unlinked).
     * Never identify a player author from this alone - see authorDiscordId.
     */
    authorAccountId: bigint("author_account_id", { mode: "number" }),
    authorKind: mysqlEnum("author_kind", ["staff", "player", "system"]).notNull(),
    /**
     * WHICH player wrote it. NOT NULL for `player`, NULL for `staff`/`system`.
     *
     * ⚠ Before group tickets this column was unnecessary and did not exist: a ticket had one
     * player, so "the player" was unambiguous and every player message wrote authorAccountId=null.
     * With N players the author must be on the row - both to label the relay ("Jean Dupont a
     * écrit :") and to EXCLUDE the author from their own fan-out.
     *
     * The snowflake and not the account, for the same reason opener_discord_id existed: unlinked
     * users are accepted, so an account id cannot identify every author. Not a participant id
     * either - participants are removable, and authorship must outlive the person leaving.
     */
    authorDiscordId: varchar("author_discord_id", { length: 32 }),
    body: text("body").notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_ticket_messages_ticket").on(t.ticketId)],
);

/**
 * WHO is on a ticket - the table that makes a group ticket a group.
 *
 * Owner decision 2026-07-17: staff can create a ticket and add several players; every message
 * fans out to all the others so they see each other. Discord bots CANNOT create group DMs (that
 * needs a user token and the gdm.join scope), so the group conversation is BUILT from N 1:1 DMs.
 *
 * THIS IS WHERE THE DM-ABLE INVARIANT LIVES NOW: `discord_id` is NOT NULL, so every participant
 * is by construction someone the bot can reach. tickets.opener_discord_id kept the invariant only
 * while a ticket had exactly one player.
 *
 * Adding is STAFF-ONLY (owner decision): a player who could add someone could hand a third party
 * a ticket's history.
 */
export const citadelTicketParticipants = mysqlTable(
  CT.ticketParticipants,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    /** The DM address. NOT NULL - this is the invariant that moved here from tickets. */
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    /** Identity-graph account when linked. NULL = unlinked, which is accepted. */
    accountId: bigint("account_id", { mode: "number" }),
    /**
     * WHICH character of theirs this ticket concerns (bare-hex license) - the source of the RP
     * name the relay signs their messages with. NULL when unlinked or unknown, which is exactly
     * why the relay label must fall back to a neutral "Joueur" and never to their @handle.
     *
     * ⚠ Bare-hex. Never join column-to-column against `users.identifier` - collation mismatch
     * (citadel_* general_ci vs ESX unicode_ci) throws at runtime. Resolve per-id, bound param.
     */
    subjectIdentifier: varchar("subject_identifier", { length: 60 }),
    /** `opener` DM'd the bot; `participant` was added by staff. Decides what `!close` means. */
    role: mysqlEnum("role", ["opener", "participant"]).default("participant").notNull(),
    /** The staff account that added them. NULL for an opener (nobody added them). */
    addedBy: bigint("added_by", { mode: "number" }),
    addedAt: createdNow("added_at"),
    /**
     * SOFT removal. Set when staff removes them or a participant `!close`s (which means LEAVE for
     * anyone who is not the opener). Never a DELETE: their past messages and deliveries must stay
     * readable, and a re-add should read as a return rather than erase that they were ever gone.
     */
    leftAt: nullableDate("left_at"),
  },
  (t) => [
    // The fan-out read on every single message: "who else is live on this ticket?"
    index("idx_ticket_participants_ticket").on(t.ticketId),
    // The bot's inbound hot path, replacing idx_tickets_opener: "which tickets is this snowflake on?"
    index("idx_ticket_participants_discord").on(t.discordId),
    // One row per person per ticket. Makes re-adding an idempotent upsert that clears left_at,
    // rather than a second row that would double every future DM to them.
    uniqueIndex("uq_ticket_participant").on(t.ticketId, t.discordId),
  ],
);

/**
 * Per-RECIPIENT DM outcome for one message - the fan-out ledger.
 *
 * Replaces the scalar delivery_* columns on citadel_ticket_messages (see that table's header for
 * why they could not survive N>1). One row per (message, recipient), written `pending` by the
 * WRITER at the same time as the message, so the panel shows pending immediately and a job that
 * never runs reads as a stuck pending rather than as nothing at all.
 */
export const citadelTicketDeliveries = mysqlTable(
  CT.ticketDeliveries,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * Denormalized from the message. Drift-free (a message never changes tickets) and it is what
     * lets an inbound Discord reply resolve to a ticket in ONE indexed query with no join.
     */
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    /**
     * A SNAPSHOT of the recipient, not a participant reference: the ledger must still say who we
     * DM'd after they are removed from the ticket.
     */
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    /**
     * No `na` here. `na` on the old scalar meant "this column does not apply to this row"; a
     * per-recipient row expresses that by simply not existing. An inbound player message has
     * delivery rows for the OTHER participants and none for its own author.
     */
    status: mysqlEnum("status", ["pending", "sent", "failed"]).default("pending").notNull(),
    error: varchar("error", { length: 255 }),
    /**
     * The name THIS recipient actually saw it signed with. Per-recipient by nature: the same
     * message is signed "Jean Dupont · Modérateur" to a normal player and "MP STAFF" to a banned
     * one. Recorded because the rule's inputs (is this player banned) change, so replaying it
     * later would answer a different question than the one asked at send time.
     */
    deliveredAs: varchar("delivered_as", { length: 64 }),
    /**
     * The id of the DM message Discord actually created. This is what makes "player hits reply in
     * Discord" resolve to the right ticket with zero ambiguity - the routing rule's first and best
     * case. sendDm used to discard user.send()'s return value.
     */
    discordMessageId: varchar("discord_message_id", { length: 32 }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    // Idempotency on retry, and leftmost-messageId so it also serves "all deliveries for message".
    uniqueIndex("uq_ticket_delivery").on(t.messageId, t.discordId),
    // Inbound reply resolution: reply.reference.messageId -> ticket, one query.
    uniqueIndex("uq_ticket_delivery_discord_msg").on(t.discordMessageId),
    // The panel's per-thread render.
    index("idx_ticket_deliveries_ticket").on(t.ticketId),
  ],
);

/**
 * PER-STAFF read state on a ticket thread - the thing that makes a queue row bold.
 *
 * ⚠ A COLUMN ON citadel_tickets CANNOT EXPRESS THIS, which is the whole reason this table exists:
 * "is there a new message" has a different answer for every staff member looking at the same row.
 * A shared `has_unread` flag would be cleared by whoever glanced at it first and go quiet for
 * everyone else - which is precisely the failure the owner reported ("no way to know if there is a
 * new message"), just with extra steps.
 *
 * Stores the last message id this account has SEEN, not a boolean: unread is then
 * `ticket.lastMessageId > lastReadMessageId`, which is monotonic, needs no clearing pass, and
 * cannot drift. A ticket with no row here has never been opened by that account - correctly unread.
 *
 * This is NOT the same question as "à répondre" (the last message is from a player), which is
 * global, derived, and needs no state at all. Both are rendered; they answer different things.
 */
export const citadelTicketReads = mysqlTable(
  CT.ticketReads,
  {
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
    /** The newest citadel_ticket_messages.id this account had seen when it last opened the thread. */
    lastReadMessageId: bigint("last_read_message_id", { mode: "number" }).default(0).notNull(),
    readAt: createdNow("read_at"), // app-maintained on UPDATE
  },
  (t) => [
    // One row per (staff, ticket). Makes marking read an idempotent upsert rather than a
    // read-then-write that two tabs can race.
    primaryKey({ columns: [t.accountId, t.ticketId] }),
    // The queue's own read: "everything I have seen, for the tickets on screen".
    index("idx_ticket_reads_account").on(t.accountId),
  ],
);

/**
 * Durable cursors for the notification SWEEPER (lib/notify/sweeper.ts).
 *
 * ⚠ NOT citadel_config, and the distinction matters: that table is a typed, panel-editable, audited
 * store of DECISIONS someone made, and its UI lists every row. A cursor is runtime bookkeeping -
 * showing it beside "VPN gate enabled" invites someone to edit it, and editing it silently replays
 * or skips notifications.
 *
 * PERSISTED because the alternative loses events: the realtime pollers keep their cursor in memory
 * and pin it to head() at boot, which is right for a LIVE UI (nobody wants yesterday's flags
 * animating in) and wrong for a notification (an anticheat flag at 3am is exactly what you want
 * waiting in the bell at 9am). Restart the panel with an in-memory cursor and everything that
 * happened during the downtime is gone for good.
 */
export const citadelNotifyCursors = mysqlTable(CT.notifyCursors, {
  /** Source key - e.g. "anticheat", "bans", "reports". Owned by sweeper.ts's source list. */
  k: varchar("k", { length: 64 }).primaryKey(),
  /**
   * The last source-row id we have emitted for.
   *
   * ⚠ NOT named `cursor`: CURSOR is a RESERVED WORD in MariaDB. Drizzle backticks every identifier
   * so the ORM would never have noticed, which is exactly the problem - the trap would have been
   * armed for the first person to write raw SQL against this table (`SELECT k, cursor FROM …` is an
   * ER_PARSE_ERROR), and every diagnostic query anyone reaches for at 3am is raw SQL.
   */
  pos: bigint("pos", { mode: "number" }).default(0).notNull(),
  updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
});

/**
 * The bot's CONVERSATION STATE. The TASEv3 flow is stateful - pick a character, then pick a type,
 * then talk - and today's bot is a stateless one-shot listener, so this is what makes the menu
 * possible at all.
 *
 * PERSISTED, not in-memory: the bot restarts (deploys, crashes, the worker loop), and a player
 * halfway through "tape 1 ou 2" must not be stranded talking to something that forgot the question.
 */
export const citadelTicketSessions = mysqlTable(CT.ticketSessions, {
  /** One conversation per Discord user - the DM channel IS the session. */
  discordId: varchar("discord_id", { length: 32 }).primaryKey(),
  /**
   * `await_ticket` (2026-07-17) is the group-ticket addition: a player can now be on several live
   * tickets at once (staff added them to one while their own was open), so an inbound DM is no
   * longer unambiguous. It is the LAST resort of the routing rule, never the first - a Discord
   * native reply resolves exactly, and one live ticket needs no question.
   */
  state: mysqlEnum("state", ["await_character", "await_type", "await_body", "await_ticket"]).notNull(),
  /**
   * The numbered list we offered, so "2" can be resolved back. Serves both pickers:
   * characters `[{ n, identifier, name, lastSeen }]` and tickets `[{ n, ticketId, ref, label }]`.
   * Which one it holds is decided by `state`.
   */
  candidates: text("candidates"),
  /** The character they picked (bare-hex license), or NULL when they have one/none. */
  selectedIdentifier: varchar("selected_identifier", { length: 60 }),
  /** The type they picked, held until their NEXT message (the problem description) opens the ticket. */
  selectedType: mysqlEnum("selected_type", ["deban", "mortrp", "register", "dossier", "candidature", "other"]),
  /**
   * The message they ALREADY SENT that we could not route, held across the "which ticket?" round
   * trip. Without it the picker would have to say "now type your message again" - the player has
   * already written it, and asking twice for the same words is how a support flow gets abandoned.
   */
  pendingBody: text("pending_body"),
  /**
   * What to do with pendingBody once they pick. `!close` has to survive the picker too - someone
   * with two live tickets typing `!close` is exactly as ambiguous as any other message, and
   * closing the wrong one is worse than closing none.
   */
  pendingAction: mysqlEnum("pending_action", ["append", "close"]),
  updatedAt: createdNow("updated_at"),
});

/**
 * Ticket blocklist - the release valve for the one person who opens 40 tickets a night
 * (owner decision 2026-07-16, alongside the per-user open cooldown).
 *
 * Blocks the SNOWFLAKE, not the account: an unlinked user has no account, and the snowflake is the
 * thing actually doing the DMing. A blocked user's DMs are ignored SILENTLY - no "you are blocked"
 * reply, because that reply is itself a thing to spam, and it tells someone building an alt exactly
 * when they've been noticed.
 *
 * NOT a ban and never treated as one: it stops ticket intake, nothing else. Someone can be blocked
 * here and perfectly welcome in-game.
 */
export const citadelTicketBlocks = mysqlTable(CT.ticketBlocks, {
  discordId: varchar("discord_id", { length: 32 }).primaryKey(),
  reason: varchar("reason", { length: 255 }).notNull(),
  blockedBy: bigint("blocked_by", { mode: "number" }),
  blockedAt: createdNow("blocked_at"),
});

/* ── Anti-cheat review (false-positive dismissals - CITADEL-side, no game bridge) ────────────
 * gs_logs (the flag source) is game-owned and has no per-row reviewed/dismissed column (CLAUDE.md:
 * CITADEL only reads gs_logs). A dismissal here is a CUTOFF, not a per-flag flag: any detection at or
 * before `createdAt` for the same identifier (or, for identifier-less offenders, the same raw player
 * name - mirrors the `__unknown__<name>` fallback key the queue itself uses) is considered reviewed;
 * a NEW detection after that instant naturally brings the group back into the active queue. Multiple
 * rows accumulate as a real history (never overwritten), so this doubles as an audit trail on top of
 * citadel_audit. */
export const citadelAnticheatReviews = mysqlTable(
  CT.anticheatReviews,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    identifier: varchar("identifier", { length: 60 }),
    playerName: varchar("player_name", { length: 100 }),
    dismissedBy: bigint("dismissed_by", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 255 }),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_anticheat_reviews_identifier").on(t.identifier)],
);

/* ── PUBLISHED weapon catalog (2026-07-17) ────────────────────────────────────────
 * The INVERTED table in this schema: CITADEL owns and MIGRATES it (it is citadel_*), but the GAME
 * is the only WRITER - gs_citadel publishes es_extended's `Config.Weapons` here. CITADEL only ever
 * reads it (lib/data/weapons.ts). That is the opposite of every other table in this file, so it is
 * called out loudly rather than left to be inferred from the absence of a write path.
 *
 * WHY A PUBLISHED TABLE AND NOT A LUA READ (the vehicleList.lua/vehicleModels.ts pattern):
 * es_extended/config.weapons.lua:50+ states every weapon as `label = _U('weapon_pistol')` - a
 * LOCALE CALL resolved at runtime inside es_extended's own VM against its locale files, not a
 * string literal. Verified 2026-07-17: 469 `_U(` calls in that file. vehicleList.lua stores real
 * literals (`name = 'Dubsta 6x6'`), which is exactly why a regex works there and cannot work here -
 * a regex would recover `WEAPON_PISTOL` and, for the label, only the string `_U('weapon_pistol')`.
 * Resolving that ourselves would mean reimplementing `_U` + parsing the locale tables, i.e. a
 * second source of truth that silently drifts. So the game - the only VM where `_U` is real -
 * resolves the label and publishes the finished text. (The publisher is NOT built yet; see below.)
 *
 * `components`/`tints` are JSON because their shape is the game's, not CITADEL's: components are a
 * list of {name,label,type} and tints a label list. Storing them opaquely means a publisher change
 * does not require a migration here.
 *
 * `name` is the weapon HASH NAME ('WEAPON_PISTOL') - the value the game's own give-weapon path
 * takes, so it is the natural PK and needs no surrogate id.
 */
export const citadelWeaponCatalog = mysqlTable(CT.weaponCatalog, {
  name: varchar("name", { length: 64 }).primaryKey(), // 'WEAPON_PISTOL' - game-side hash name
  label: varchar("label", { length: 128 }).notNull(), // already locale-resolved by the publisher
  ammoLabel: varchar("ammo_label", { length: 128 }), // NULL for weapons with no ammo (melee)
  components: json("components"), // [{name,label,type}] - opaque; the game owns the shape
  tints: json("tints"), // [label] - opaque; the game owns the shape
  updatedAt: createdNow("updated_at"), // set by the publisher on each republish
});

/* ── Published job-storage catalog (2026-08-15) ───────────────────────────────────
 * Owner ask: "in citadel allow admin+ to withdraw and deposit items and weapons into each job
 * storages and view all of them even if empty".
 *
 * THE SECOND HALF OF THAT SENTENCE IS WHY THIS TABLE EXISTS, and the reasoning is measured rather
 * than assumed - see the long note on CT.jobStorages. Short version: a coffre only appears in
 * `gs_inventory_storage` once a player has physically opened it (154 declared, 1 row, live, on the
 * day this was written), so the DB can never answer "all of them, even if empty". The jobs' Lua
 * config can, and only inside the game's VM, because point names are expressions rather than
 * literals. CITADEL/server/storages.lua publishes the resolved list here.
 *
 * WRITER: the game, exclusively. CITADEL reads (lib/data/jobStorages.ts) and never writes - the
 * same inverted ownership as citadelWeaponCatalog directly above.
 *
 * ⚠ THE NATURAL KEY IS (job, point_name), NOT storage_id, and the difference is not cosmetic.
 * `storage_id` is DERIVED from that pair by gs_inventory, so renaming a point in a job's config
 * produces a different id for what is conceptually the same coffre. Keying on the pair means the
 * publisher's upsert updates the row (and its now-stale id) instead of orphaning it, and the prune
 * removes a genuinely retired coffre rather than every coffre whose id happened to change.
 *
 * ⚠ `storage_id` STILL CARRIES A UNIQUE INDEX. Two declared coffres deriving the same id would mean
 * two different (job, point) pairs sharing one physical container - a deposit aimed at one would
 * land in the other, silently. The constraint turns that into a publish-time failure instead.
 *
 * ⚠ 190, NOT 255, on every indexed varchar: utf8mb4 + a classic MySQL index caps at 767 bytes =
 * 191 characters. The widths here are mirrored in CITADEL/config.lua's JobStorageCatalog block,
 * which clamps before MySQL would - the two are one fact stored twice, so move them together.
 *
 * `capacity` is the coffre's maxWeight from the job's own config. It is published (rather than read
 * live) because it is what a server-side write must provision a never-opened container with, and a
 * wrong value there is the one number that decides how much fits before a real player ever opens it.
 */
export const citadelJobStorages = mysqlTable(
  CT.jobStorages,
  {
    id: int("id").autoincrement().primaryKey(),
    job: varchar("job", { length: 64 }).notNull(), // `jobs.name` - bare job name, never 'society_x'
    pointName: varchar("point_name", { length: 190 }).notNull(), // the ActionPoint's resolved Name
    label: varchar("label", { length: 190 }).notNull(), // human label from the config, already resolved
    marker: varchar("marker", { length: 64 }), // 'Inventory' | 'Armory' - context for staff, not a key
    capacity: int("capacity").notNull().default(0), // maxWeight from the job config
    storageId: varchar("storage_id", { length: 190 }).notNull(), // gs_inventory_storage.id, derived BY gs_inventory
    updatedAt: createdNow("updated_at"), // set by the publisher on each republish
  },
  (t) => [
    uniqueIndex("uq_job_storages_point").on(t.job, t.pointName),
    uniqueIndex("uq_job_storages_storage_id").on(t.storageId),
    index("idx_job_storages_job").on(t.job),
  ],
);

/* ── Ban appeals (Page 5 · Bans & Appels) ─────────────────────────────────────────
 * Mirrors citadelReports/citadelReportMessages EXACTLY - same workflow (submit -> claim ->
 * thread -> decide), same shape, deliberately not reinvented. The only structural difference is
 * the identity of the "reporter": here it's a BANNED player, reached anonymously through an
 * unguessable `code` (their access token to /appeal/<code>) rather than an authenticated session,
 * since a banned player cannot sign in. `ban_id` points at the GAME-owned `bans.id` (gs_weather) -
 * CITADEL only ever READS that table (lib/data/bans.ts); this row is CITADEL's own side-channel
 * thread about it, never a write to `bans` itself. No `updated_at`: unlike reports, an appeal has
 * no "last touched" concept the UI needs - `created_at` (opened) and `decided_at` (closed) bound
 * its whole lifecycle, and thread activity lives in the messages table's own timestamps.
 */
export const citadelBanAppeals = mysqlTable(
  CT.banAppeals,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    banId: int("ban_id").notNull(), // gs_weather bans.id - read-only join, never a DB-level FK across zones
    // The appellant's access token: /appeal/<code>. Unguessable (crypto.randomUUID), single row per
    // ban - never rotated, because rotating would orphan a link already handed to the player.
    code: varchar("code", { length: 64 }).notNull().unique(),
    appellantIdentifier: varchar("appellant_identifier", { length: 60 }), // bare-hex license, resolved at mint time
    status: mysqlEnum("status", ["open", "claimed", "accepted", "rejected"])
      .default("open")
      .notNull(),
    claimedByAccount: bigint("claimed_by_account", { mode: "number" }),
    createdAt: createdNow("created_at"),
    decidedAt: nullableDate("decided_at"),
  },
  (t) => [
    index("idx_ban_appeals_status").on(t.status),
    index("idx_ban_appeals_ban").on(t.banId),
  ],
);

export const citadelBanAppealMessages = mysqlTable(
  CT.banAppealMessages,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    appealId: bigint("appeal_id", { mode: "number" }).notNull(),
    authorKind: mysqlEnum("author_kind", ["appellant", "staff"]).notNull(),
    // citadel_accounts.id of the staff member; NULL for the appellant (they have no account row -
    // they're not staff, and often not even a linked CITADEL identity, just a banned license).
    authorAccount: bigint("author_account", { mode: "number" }),
    body: text("body").notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_ban_appeal_messages_appeal").on(t.appealId)],
);

/* ── Staff moderation notes (Page 2 · Players - "Modération" tab, 2026-07-16) ─────────────────
 * NOT the game's `player_notes` (gs_notes' player-facing personal notepad, one row per identifier,
 * player-editable) - a completely different feature this happens to share a plain-English name
 * with. This is CITADEL-owned end to end (no game bridge involved, same as reports/ban appeals):
 * an append-only, staff-only annotation feed on a player, many rows, never player-visible.
 * `authorName`/`authorRank` are denormalized at write time (same convention `staff_warnings`
 * already uses for `warned_by`) so a note always shows who wrote it even if that staffer's rank
 * later changes or their account is unlinked. */
export const citadelPlayerNotes = mysqlTable(
  CT.playerNotes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    playerIdentifier: varchar("player_identifier", { length: 60 }).notNull(), // bare hex - joins users.identifier
    authorAccountId: bigint("author_account_id", { mode: "number" }),
    authorName: varchar("author_name", { length: 64 }),
    authorRank: varchar("author_rank", { length: 32 }),
    body: text("body").notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_player_notes_identifier").on(t.playerIdentifier)],
);

export const citadelMortrpMessages = mysqlTable(
  CT.mortrpMessages,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    mortrpId: bigint("mortrp_id", { mode: "number" }).notNull(),
    role: mysqlEnum("role", ["staff", "ai"]).notNull(),
    authorAccountId: bigint("author_account_id", { mode: "number" }),
    authorName: varchar("author_name", { length: 64 }),
    body: text("body").notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_mortrp_messages_mortrp").on(t.mortrpId, t.id)],
);

/* ── VIP / donator (Tebex -> CITADEL -> game) ────────────────────────────────────
 * Design: _server_build/CITADEL_VIP.md. CITADEL is THE source of truth for who holds VIP and at what
 * tier; the game only mirrors an integer gs_kvp `donatorLevel` these rows drive. A player's EFFECTIVE
 * level is the MAX(level) over their active, non-expired entitlements - computed here, pushed as a
 * single absolute `player.vip.set` job (idempotent). Tier -> level lives in lib/data/vipTiers.ts; the
 * Tebex package_id -> tierKey map is deploy data in citadel_config `vip.package_map`. No cross-zone FK
 * (accountId references citadel_accounts.id by value, identifier is bare hex joining users.identifier).
 */

/**
 * Append-only ledger of every Tebex webhook we accept. THE idempotency guard: `webhook_id` is unique,
 * so a Tebex delivery retry can never double-apply a grant. Also the audit trail and the debug record
 * - the full VERIFIED payload is kept in `raw` (data we keep, never re-trust). `outcome` records WHY a
 * paid event granted nothing (unmapped package, no Discord link -> code issued, disabled), so support
 * can answer "I paid and got nothing" from one row.
 */
export const citadelVipTransactions = mysqlTable(
  CT.vipTransactions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Tebex webhook event id. A retried delivery reuses it -> UNIQUE = exactly-once apply.
    webhookId: varchar("webhook_id", { length: 64 }).notNull().unique(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    outcome: mysqlEnum("outcome", ["applied", "pending_code", "ignored", "failed"])
      .default("failed")
      .notNull(),
    tebexTransactionId: varchar("tebex_transaction_id", { length: 64 }),
    subscriptionId: varchar("subscription_id", { length: 64 }),
    packageId: varchar("package_id", { length: 64 }),
    tierKey: varchar("tier_key", { length: 32 }),
    discordId: varchar("discord_id", { length: 32 }),
    accountId: bigint("account_id", { mode: "number" }),
    entitlementId: bigint("entitlement_id", { mode: "number" }),
    email: varchar("email", { length: 255 }),
    // Money as a STRING, never a float - we only display/audit it, never compute on it.
    amount: varchar("amount", { length: 32 }),
    currency: varchar("currency", { length: 8 }),
    raw: json("raw").notNull(),
    note: varchar("note", { length: 255 }),
    receivedAt: createdNow("received_at"),
  },
  (t) => [
    index("idx_vip_txn_sub").on(t.subscriptionId),
    index("idx_vip_txn_txn").on(t.tebexTransactionId),
    index("idx_vip_txn_event").on(t.eventType),
  ],
);

/**
 * One row per granted entitlement (current + historical). Effective level for a player =
 * MAX(level) WHERE status='active' AND (expires_at IS NULL OR expires_at > now).
 *
 * `level` is SNAPSHOT from the tier at grant time so a later tier redefinition cannot silently rewrite
 * history or change what was pushed in-game. `accountId`/`identifier` are NULL only while `pending`
 * (a purchase waiting on a redeem code to bind it).
 */
export const citadelVipEntitlements = mysqlTable(
  CT.vipEntitlements,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("account_id", { mode: "number" }),
    // Bare-hex license the grant is applied to in-game (joins users.identifier). Denormalized so the
    // grant/sweeper path never has to re-resolve the account.
    identifier: varchar("identifier", { length: 60 }),
    tierKey: varchar("tier_key", { length: 32 }).notNull(),
    level: int("level").notNull(),
    status: mysqlEnum("status", ["pending", "active", "expired", "revoked"])
      .default("active")
      .notNull(),
    source: mysqlEnum("source", ["tebex", "staff", "code"]).notNull(),
    startedAt: createdNow("started_at"),
    // NULL = no scheduled end (permanent, or a live subscription that keeps renewing). The sweeper
    // revokes rows whose expires_at has passed. A subscription sets this to next-renewal + grace.
    expiresAt: nullableDate("expires_at"),
    tebexSubscriptionId: varchar("tebex_subscription_id", { length: 64 }),
    tebexTransactionId: varchar("tebex_transaction_id", { length: 64 }),
    grantedBy: bigint("granted_by", { mode: "number" }), // staff account for a manual grant
    revokedReason: varchar("revoked_reason", { length: 255 }),
    lastJobId: bigint("last_job_id", { mode: "number" }), // citadel_jobs id of the last push in-game
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    index("idx_vip_ent_account").on(t.accountId, t.status),
    index("idx_vip_ent_identifier").on(t.identifier, t.status),
    index("idx_vip_ent_sub").on(t.tebexSubscriptionId),
    // The sweeper's scan: active rows with an elapsed expiry.
    index("idx_vip_ent_sweep").on(t.status, t.expiresAt),
  ],
);

/**
 * The Discord-fallback binding path. A purchase whose Discord link can't be resolved issues one of
 * these; the buyer redeems it in the panel (already Discord-authenticated) to bind the entitlement to
 * their account. The entitlement is created up-front as `pending` and this code activates it, so the
 * ledger already reflects the purchase before anyone redeems.
 */
export const citadelVipRedeemCodes = mysqlTable(
  CT.vipRedeemCodes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 24 }).notNull().unique(),
    tierKey: varchar("tier_key", { length: 32 }).notNull(),
    level: int("level").notNull(),
    status: mysqlEnum("status", ["active", "redeemed", "revoked", "expired"])
      .default("active")
      .notNull(),
    entitlementId: bigint("entitlement_id", { mode: "number" }),
    sourceTransactionId: varchar("source_transaction_id", { length: 64 }),
    subscriptionId: varchar("subscription_id", { length: 64 }),
    createdBy: bigint("created_by", { mode: "number" }), // staff issuer, or NULL for webhook-issued
    redeemedByAccountId: bigint("redeemed_by_account_id", { mode: "number" }),
    redeemedIdentifier: varchar("redeemed_identifier", { length: 60 }),
    redeemedAt: nullableDate("redeemed_at"),
    expiresAt: nullableDate("expires_at"), // unredeemed-code expiry
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_vip_code_status").on(t.status)],
);

/**
 * THE BUYER behind a purchase: who paid, how to reach them, and which character it was for.
 *
 * ⚠ THIS TABLE IS PERSONAL DATA - a real legal name, a billing address, an email, and the in-game
 * phone number the buyer typed at checkout. Treat every column here as regulated, not as telemetry:
 *
 *  - It is SEPARATE from citadel_vip_transactions deliberately. That table is an append-only ledger
 *    of webhook EVENTS and is read by the grant path; this one is identity. Splitting them means a
 *    staff member can be granted "see the ledger" without being granted "see everyone's home
 *    address", and means a retention/erasure request is a DELETE here rather than surgery on an
 *    audit trail that must stay intact.
 *  - Reads MUST be permission-gated and audit-logged at the call site. There is no such thing as a
 *    casual look at this table.
 *  - NOTHING here is ever sent back to a game client or rendered on a public page.
 *
 * WHY IT EXISTS AT ALL (owner requirement, 2026-07-30): a purchase that cannot be tied to a person
 * cannot be supported. When a buyer says "I paid and got nothing", staff need the email on the
 * receipt, the number they typed, and what we resolved it to - otherwise the only remedy is a refund.
 *
 * ⚠ THE PII IS SUPPLIED BY TEBEX, NOT BY OUR STOREFRONT. We never collect a name or an address: the
 * buyer types those on Tebex's hosted checkout, and they arrive on the signed webhook. The ONLY
 * field that originates with us is `phone_submitted`, which the storefront staples to the basket.
 * Do not add a name/address field to the boutique form - doing so would put this app in scope for
 * handling payment-adjacent PII directly, which is exactly what the hosted checkout avoids.
 */
export const citadelStoreCheckouts = mysqlTable(
  CT.storeCheckouts,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // The webhook delivery this came from. UNIQUE: one checkout record per Tebex event, so a
    // redelivery updates rather than duplicating a person's details.
    webhookId: varchar("webhook_id", { length: 64 }).notNull().unique(),
    // FK-by-value to citadel_vip_transactions.id (no hard FK - same convention as the rest of the
    // schema, which joins across the citadel_/game zones by value).
    transactionId: bigint("transaction_id", { mode: "number" }),
    tebexTransactionId: varchar("tebex_transaction_id", { length: 64 }),
    packageId: varchar("package_id", { length: 64 }),

    /* ── What the buyer told US (storefront-originated) ───────────────────────── */
    // Bare digits, as normalised by the storefront. NOT trusted as an identity on its own: the
    // webhook re-resolves it against users.phone_number before anything is granted.
    phoneSubmitted: varchar("phone_submitted", { length: 32 }),

    /* ── What TEBEX told us (billing details from the hosted checkout) ─────────── */
    buyerName: varchar("buyer_name", { length: 190 }),
    buyerEmail: varchar("buyer_email", { length: 255 }),
    buyerAddressLine1: varchar("buyer_address_line1", { length: 255 }),
    buyerAddressLine2: varchar("buyer_address_line2", { length: 255 }),
    buyerCity: varchar("buyer_city", { length: 128 }),
    buyerPostcode: varchar("buyer_postcode", { length: 32 }),
    buyerCountry: varchar("buyer_country", { length: 64 }),
    // Tebex's own customer/user id, when present - lets staff correlate with the Tebex panel.
    tebexCustomerId: varchar("tebex_customer_id", { length: 64 }),
    // Payment origin IP, when Tebex sends it. Fraud/chargeback investigation only.
    buyerIp: varchar("buyer_ip", { length: 45 }),

    /* ── What WE resolved it to ────────────────────────────────────────────────── */
    // Bare-hex license (joins users.identifier), NULL when nothing resolved.
    resolvedIdentifier: varchar("resolved_identifier", { length: 60 }),
    resolvedAccountId: bigint("resolved_account_id", { mode: "number" }),
    // RP character name at resolution time, snapshotted so a later rename does not rewrite history.
    resolvedCharacterName: varchar("resolved_character_name", { length: 190 }),
    // WHICH path identified the buyer. Drives the staff view's "needs attention" filter, and is the
    // metric that says whether phone capture is actually working: a rising `none` share means
    // buyers are mistyping their number or skipping the storefront.
    resolvedVia: mysqlEnum("resolved_via", ["phone", "discord", "code", "staff", "none"])
      .default("none")
      .notNull(),

    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    index("idx_store_checkout_txn").on(t.transactionId),
    index("idx_store_checkout_identifier").on(t.resolvedIdentifier),
    index("idx_store_checkout_email").on(t.buyerEmail),
    index("idx_store_checkout_phone").on(t.phoneSubmitted),
    // The staff queue: unresolved purchases, newest first.
    index("idx_store_checkout_unresolved").on(t.resolvedVia, t.createdAt),
  ],
);

/* ── The public reglement (grandside.fr/reglement), owner-editable ─────────────────
 * Replaces hand-edited HTML on an FTP server. CITADEL owns the content; the public site READS it
 * over the HMAC bridge and caches it (landing-page/src/lib/rules.ts).
 *
 * ⚠ THIS IS PUBLIC CONTENT, NOT PLAYER DATA. The opposite handling from citadel_store_checkouts
 * directly above: it is meant to be read by anyone, so the sensitive operation here is the WRITE,
 * not the read. The editor is Fondateur-only and audited; the read endpoint is deliberately cheap.
 *
 * ⚠ BODY TEXT IS A TINY MARKDOWN SUBSET, NOT HTML - `[label](url)` and `**bold**`, nothing else.
 * It is parsed into React elements by a hand-written renderer that validates URL schemes; it is
 * NEVER passed to dangerouslySetInnerHTML. That keeps a compromised staff account from turning the
 * rules page into stored XSS on the public site. Do not "upgrade" this to raw HTML.
 */
export const citadelSiteRuleSections = mysqlTable(
  CT.siteRuleSections,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // URL anchor for deep links (`/reglement#reglement-mortrp`). Stable across a title rename,
    // which is why it is stored rather than slugified from the title at render time - the existing
    // rules already cross-reference `#reglement-mortrp` and those links must not rot.
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    title: varchar("title", { length: 190 }).notNull(),
    // Optional lead-in shown under the title (e.g. the Illegal section's "Rappel: ...").
    subtitle: varchar("subtitle", { length: 500 }),
    position: int("position").notNull().default(0),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_site_rule_section_pos").on(t.position)],
);

export const citadelSiteRuleItems = mysqlTable(
  CT.siteRuleItems,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sectionId: bigint("section_id", { mode: "number" }).notNull(),
    // The displayed rule number ("1.3"). Also its anchor id, which is how the cross-references in
    // the body text work. A string, not a decimal: "1.10" must sort and render after "1.9", and a
    // numeric type would collapse them to the same value.
    number: varchar("number", { length: 16 }).notNull(),
    body: text("body").notNull(),
    position: int("position").notNull().default(0),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_site_rule_item_section").on(t.sectionId, t.position)],
);

/* ── Manuel de moderation (/staff/manuel) ─────────────────────────────────────────
 * The INTERNAL staff manual. Sibling of the reglement above, deliberately not the same tables:
 * that one is public content with a single shape (numbered rules), this one is staff-only and every
 * tab has its own shape.
 *
 * ⚠ THE FIELD SYSTEM IS THE FEATURE, NOT AN ABSTRACTION FOR ITS OWN SAKE. A tab declares its own
 * columns in `fields`, and its entries store values against those keys in `values`. The source
 * material proves why: the standing-directives tab carries an author, the ticket tab is
 * type -> subject -> who to assign, the sanctions tab is infraction -> what to check -> reference
 * sanction, the commands tab is command -> description -> who may run it. With a fixed column set,
 * every new tab shape is a migration, and the owner's actual requirement - add and delete tabs from
 * the panel - would be impossible to honour. Trading a JSON column for that is the right trade.
 */
export const citadelManualTabs = mysqlTable(
  CT.manualTabs,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Drives `?tab=` and therefore every deep link staff paste to each other. Stored rather than
    // derived from the title at render time, for the same reason the reglement stores its anchor:
    // a rename must not rot the links already sent.
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    title: varchar("title", { length: 190 }).notNull(),
    subtitle: varchar("subtitle", { length: 500 }),
    // A navIcons.ts key. Nullable: a tab with no icon renders a neutral dot rather than blocking
    // the Fondateur from creating one because they had no opinion about an icon.
    icon: varchar("icon", { length: 40 }),
    // Which renderer the reading pane uses. 'list' = expandable cards (the default and the one that
    // suits long prose entries), 'table' = a dense grid for short uniform rows, 'prose' = one
    // capped reading column with no per-entry chrome.
    layout: mysqlEnum("layout", ["list", "table", "prose"]).default("list").notNull(),
    // [{ key, label, type }] - see ManualField in lib/data/manual.ts. Empty array is valid and
    // common: a prose tab has a title and a body and nothing else.
    fields: parsedJson<ManualFieldDef[]>()("fields"),
    position: int("position").notNull().default(0),
    // An unpublished tab is invisible to readers but still editable, so the Fondateur can draft a
    // tab across several sittings instead of publishing something half-written to the whole team.
    published: boolean("published").notNull().default(true),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_manual_tab_pos").on(t.position)],
);

export const citadelManualEntries = mysqlTable(
  CT.manualEntries,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    tabId: bigint("tab_id", { mode: "number" }).notNull(),
    // Slug within the tab, so `?tab=sanctions&e=freekill` addresses one entry. Unique per tab, not
    // globally: two tabs may both legitimately have a "register" entry.
    slug: varchar("slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 190 }).notNull(),
    body: text("body").notNull(),
    // Values for the tab's declared fields, keyed by field key. A key with no matching field
    // definition is kept, not dropped - removing a column from a tab must not silently destroy the
    // content typed into it, in case the removal was a mistake.
    values: parsedJson<Record<string, string>>()("values"),
    position: int("position").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_manual_entry_tab").on(t.tabId, t.position),
    uniqueIndex("uq_manual_entry_slug").on(t.tabId, t.slug),
  ],
);

/**
 * Per-staff read cursor. `lastSeenAt` is compared against the tab's newest entry `updatedAt` to
 * decide whether the tab shows a "nouveau" dot.
 *
 * ⚠ A COLUMN ON citadel_manual_tabs CANNOT EXPRESS THIS. "Has this changed since you read it" has a
 * different answer per staff member; a shared flag is cleared by whoever opens the tab first, which
 * is precisely the failure this exists to avoid. Same shape and same reasoning as
 * citadel_ticket_reads. A missing row is correctly "never read".
 */
export const citadelManualReads = mysqlTable(
  CT.manualReads,
  {
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    tabId: bigint("tab_id", { mode: "number" }).notNull(),
    lastSeenAt: createdNow("last_seen_at"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.tabId] })],
);

/* ── Prop deletion recycle bin (reversible gs_props delete) ───────────────────────
 * EVERY placed-object removal snapshots here BEFORE the gs_props row is deleted, so any deletion is
 * reversible from the panel. The container's items SURVIVE deletion in gs_inventory (keyed prop_<id>),
 * so restore = re-insert the gs_props row with the SAME id and the contents reconnect automatically;
 * the placement slot is derived from gs_props rows, so it frees/reclaims by itself. `snapshot` is the
 * full gs_props row; `contents` is the container's items at delete time (display only). Written by
 * gs_utils/propMenu (the game INSERTs a citadel_* row, like reports); restore enqueues a prop.restore
 * job. No cross-zone FK (identifiers are bare hex joining users.identifier by value).
 */
export const citadelPropDeletions = mysqlTable(
  CT.propDeletions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // gs_props numeric id. Restore re-inserts gs_props with THIS id so the surviving contents reconnect.
    // NOT unique: a prop can be deleted, restored, and deleted again.
    propId: bigint("prop_id", { mode: "number" }).notNull(),
    ownerIdentifier: varchar("owner_identifier", { length: 60 }).notNull(), // bare hex, joins users.identifier
    deletedByIdentifier: varchar("deleted_by_identifier", { length: 60 }), // bare hex; null when unknown
    deletedByName: varchar("deleted_by_name", { length: 64 }),
    // true when the deleter is not the owner (an admin removed a player's object).
    isAdminDelete: boolean("is_admin_delete").default(false).notNull(),
    // Full gs_props row (owner, model, x/y/z, rx/ry/rz, sx/sy/sz, tint, instance, category, job, level,
    // password, custom_label) - everything needed to re-insert it byte-for-byte.
    snapshot: json("snapshot").notNull(),
    // Container contents at delete time (display only; restore relies on the surviving live rows). Null
    // for a non-storage prop.
    contents: json("contents"),
    status: mysqlEnum("status", ["deleted", "restored"]).default("deleted").notNull(),
    restoredByAccountId: bigint("restored_by_account_id", { mode: "number" }),
    restoredAt: nullableDate("restored_at"),
    lastJobId: bigint("last_job_id", { mode: "number" }), // citadel_jobs id of the restore push
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    index("idx_prop_del_owner").on(t.ownerIdentifier, t.status),
    index("idx_prop_del_status").on(t.status),
    index("idx_prop_del_prop").on(t.propId),
  ],
);

/* ══ CAD / MDT ═══════════════════════════════════════════════════════════════════════════════════
 * The law-enforcement, fire, and justice workspace at /cad.
 * Design: fivem/server-data/_server_build/CITADEL_CAD_MDT_PLAN.md.
 *
 * OWNERSHIP: every table here is CITADEL-owned and migrated EXCEPT citadel_cad_presence, which is the
 * second game-WRITTEN citadel_* table (the first is citadel_weapon_catalog). The game owns its rows;
 * CITADEL migrates the shape and reads it as the hard duty gate. See CITADEL/server/cad_presence.lua.
 *
 * COLLATION: every license/plate column is bare-hex/plate text in citadel_* (utf8mb4_general_ci) and
 * MUST NOT be JOINed column-to-column against the game's `users`/`owned_vehicles` (utf8mb4_unicode_ci)
 * - resolve per-id with a bound parameter, exactly as tickets/prop-deletions do.
 *
 * SECURITY MODEL (enforced in the data + action layer, not the DB): agency is the ACL axis. Every read
 * filters to the viewer's accessible agencies; every write re-checks the live duty lease and the
 * agency, never trusts an object id as authorization, and appends an immutable audit + timeline event.
 */

/**
 * DUTY PRESENCE LEASE - game-written (CITADEL/server/cad_presence.lua), CITADEL-read.
 * The single source of truth for "is this character on duty for a CAD agency RIGHT NOW". A row whose
 * expires_at is in the past is OFF DUTY (fail-closed): a crashed game server lets every lease lapse
 * rather than stranding someone with live CAD write access. Keyed by bare-hex license.
 */
export const citadelCadPresence = mysqlTable(
  CT.cadPresence,
  {
    license: varchar("license", { length: 60 }).primaryKey(), // bare hex, joins citadel_identifiers.value
    serverId: int("server_id").notNull(),
    agency: varchar("agency", { length: 32 }).notNull(), // agency id (agencies.ts), NOT the raw job name
    job: varchar("job", { length: 60 }).notNull(),
    grade: int("grade").default(0).notNull(),
    // CITADEL-managed dispatch callsign, set from the panel. The game leaves it NULL; a unit shows its
    // grade until a callsign is assigned. Nullable so the game writer never has to invent one.
    callsign: varchar("callsign", { length: 24 }),
    since: createdNow("since"), // preserved across heartbeat refreshes (time-in-service)
    expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_cad_presence_agency").on(t.agency),
    index("idx_cad_presence_expires").on(t.expiresAt),
  ],
);

/**
 * INCIDENT - the shared operational record (a CAD call). The one object multiple units and, under
 * policy, multiple agencies act on. `version` is bumped on every mutation for optimistic concurrency
 * so two dispatchers editing the same call conflict visibly instead of silently overwriting.
 */
export const citadelCadIncidents = mysqlTable(
  CT.cadIncidents,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Player-quotable, random (not derived from id, which would leak call volume). Prefix "IN-".
    publicRef: varchar("public_ref", { length: 12 }).notNull(),
    // The originating/owning agency. Cross-agency visibility is additive (participants), never by
    // widening this. Bare agency id from agencies.ts.
    agency: varchar("agency", { length: 32 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    // 1 = high/emergency, 2 = medium (default), 3 = low. tinyint, not an enum, so re-tuning the scale
    // is data not a migration.
    priority: tinyint("priority").default(2).notNull(),
    status: mysqlEnum("status", ["pending", "active", "onscene", "closed"]).default("pending").notNull(),
    location: varchar("location", { length: 200 }),
    postal: varchar("postal", { length: 16 }),
    createdByLicense: varchar("created_by_license", { length: 60 }).notNull(),
    createdByName: varchar("created_by_name", { length: 120 }).notNull(), // RP name, resolved at write time
    closedAt: nullableDate("closed_at"),
    closedByLicense: varchar("closed_by_license", { length: 60 }),
    version: int("version").default(1).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_cad_incident_agency").on(t.agency, t.status),
    index("idx_cad_incident_status").on(t.status),
    index("idx_cad_incident_created").on(t.createdAt),
    uniqueIndex("uq_cad_incident_ref").on(t.publicRef),
  ],
);

/**
 * INCIDENT TIMELINE - append-only. Never edited, never deleted: the record of who did what, when, and
 * from which source. `kind` classifies the event (created/note/status/priority/location/unit_assigned/
 * unit_cleared/closed/bolo_link/…); `data` carries the structured before/after for policy-safe diffs.
 */
export const citadelCadIncidentEvents = mysqlTable(
  CT.cadIncidentEvents,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    incidentId: bigint("incident_id", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    actorLicense: varchar("actor_license", { length: 60 }), // null for system-generated events
    actorName: varchar("actor_name", { length: 120 }),
    body: text("body"),
    data: json("data"),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_cad_incident_event_incident").on(t.incidentId, t.id)],
);

/**
 * UNIT ASSIGNMENT - which on-duty units are attached to an incident. Composite PK (incident, unit)
 * makes a double-assign a no-op rather than a duplicate row. A unit is a bare-hex license; its live
 * identity/agency is resolved through the presence lease, never stored redundantly here.
 */
export const citadelCadIncidentUnits = mysqlTable(
  CT.cadIncidentUnits,
  {
    incidentId: bigint("incident_id", { mode: "number" }).notNull(),
    unitLicense: varchar("unit_license", { length: 60 }).notNull(),
    primaryUnit: boolean("primary_unit").default(false).notNull(),
    assignedByLicense: varchar("assigned_by_license", { length: 60 }),
    assignedByName: varchar("assigned_by_name", { length: 120 }),
    assignedAt: createdNow("assigned_at"),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.unitLicense] }),
    index("idx_cad_incident_unit_unit").on(t.unitLicense),
  ],
);

/**
 * UNIT OPERATIONAL STATUS - CITADEL-owned (the presence lease says WHO is on duty; this says what they
 * are DOING). Keyed by license; a unit's liveness is the presence lease, so a stale status for someone
 * off duty is simply ignored by every read. `incidentId` is the call they are currently committed to.
 */
export const citadelCadUnitStatus = mysqlTable(
  CT.cadUnitStatus,
  {
    license: varchar("license", { length: 60 }).primaryKey(),
    agency: varchar("agency", { length: 32 }).notNull(),
    // Per-officer operational status (the roster "radio" picker). Vocabulary is owner-tuned in
    // src/lib/cad/dispatchConfig.ts (UNIT_STATUSES); keep the two lists in sync. NULLABLE: a null /
    // absent row = unset (empty picker, neutral dot). "busy" is kept from the old enum (= "Occupé").
    status: mysqlEnum("status", [
      "busy",
      "dispatch",
      "opcommand",
      "negotiator",
      "otherjuris",
      "code1086",
      "reception",
      "code1062",
      "meeting",
    ]),
    incidentId: bigint("incident_id", { mode: "number" }),
    note: varchar("note", { length: 160 }),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_cad_unit_status_agency").on(t.agency, t.status)],
);

/**
 * BOLO - be-on-the-lookout. Published, cancellable alerts scoped to an agency. Append-only status
 * transitions (a BOLO is never silently edited into a different subject); `version` guards concurrent
 * edits like incidents.
 */
export const citadelCadBolos = mysqlTable(
  CT.cadBolos,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 12 }).notNull(), // prefix "BO-"
    agency: varchar("agency", { length: 32 }).notNull(),
    category: mysqlEnum("category", ["person", "vehicle", "other"]).default("other").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    plate: varchar("plate", { length: 16 }), // when category = vehicle
    subjectName: varchar("subject_name", { length: 120 }), // when category = person
    // when category = person: the character's bare-hex users.identifier, so the game can expand a
    // person BOLO to that person's OWNED vehicles (gs_jobs/modules/searchedPlates). Nullable: a person
    // BOLO can still be a name-only notice with no linked character.
    subjectIdentifier: varchar("subject_identifier", { length: 60 }),
    // Last in-world sighting, written by the game when a plate reader hits this BOLO's plate (vehicle
    // BOLOs). Lets the CAD show where/when a flagged vehicle was last seen.
    lastSeenAt: nullableDate("last_seen_at"),
    lastSeenX: float("last_seen_x"),
    lastSeenY: float("last_seen_y"),
    lastSeenZ: float("last_seen_z"),
    priority: tinyint("priority").default(2).notNull(),
    status: mysqlEnum("status", ["active", "cancelled", "expired", "apprehended"]).default("active").notNull(),
    createdByLicense: varchar("created_by_license", { length: 60 }).notNull(),
    createdByName: varchar("created_by_name", { length: 120 }).notNull(),
    cancelledAt: nullableDate("cancelled_at"),
    cancelledByLicense: varchar("cancelled_by_license", { length: 60 }),
    // The unit board's group NAME (dispatchConfig callsign, e.g. "Alpha"), not a foreign key to
    // citadel_cad_groups - a dispatch board is reset/reshuffled far more often than a BOLO stays open,
    // so a live FK would routinely point at a group that no longer exists. A free-text label, same as
    // the group's own display name, is honest about that: it names who WAS assigned, not a row that
    // must still exist.
    assignedUnitName: varchar("assigned_unit_name", { length: 64 }),
    apprehendedAt: nullableDate("apprehended_at"),
    apprehendedByLicense: varchar("apprehended_by_license", { length: 60 }),
    version: int("version").default(1).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_cad_bolo_agency").on(t.agency, t.status),
    index("idx_cad_bolo_status").on(t.status),
    uniqueIndex("uq_cad_bolo_ref").on(t.publicRef),
  ],
);

/**
 * DISPATCH GROUP - a callsign board group (Alpha, Bravo, Oscar/Dispatch, …), the TASEv3 dispatch
 * model. A dispatcher creates groups, sets a free label + a status code (S1..S4) + a radio 10-code +
 * a colour, and drags in-service units into them. Ephemeral operational state, versioned for
 * concurrent-edit safety.
 */
export const citadelCadGroups = mysqlTable(
  CT.cadGroups,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    agency: varchar("agency", { length: 32 }).notNull(),
    name: varchar("name", { length: 48 }).notNull(), // callsign, e.g. "Alpha", "Oscar/Dispatch"
    label: varchar("label", { length: 80 }), // free text, e.g. "BS HSP 065"
    color: varchar("color", { length: 16 }).default("green").notNull(), // dispatchConfig.GROUP_COLORS id
    statusCode: varchar("status_code", { length: 8 }), // S1..S4
    radioCode: varchar("radio_code", { length: 16 }), // 10-68, Code 3, …
    sortOrder: int("sort_order").default(0).notNull(), // dispatcher drag-to-reorder on the board
    createdByLicense: varchar("created_by_license", { length: 60 }).notNull(),
    version: int("version").default(1).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_cad_group_agency").on(t.agency)],
);

/**
 * GROUP MEMBERSHIP - which in-service unit is in which group. A unit is in at most one group per
 * agency (assign removes any prior membership), so composite PK (group, unit) plus a unit index for
 * the "which group is this unit in" lookup.
 *
 * Cleared by the game on off-duty (`CITADEL/server/cad_presence.lua` clearDispatchSeat): leave
 * service must not re-seat the unit in the same group when they take service again.
 */
export const citadelCadGroupMembers = mysqlTable(
  CT.cadGroupMembers,
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    unitLicense: varchar("unit_license", { length: 60 }).notNull(),
    agency: varchar("agency", { length: 32 }).notNull(),
    assignedAt: createdNow("assigned_at"),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.unitLicense] }),
    index("idx_cad_group_member_unit").on(t.unitLicense),
    index("idx_cad_group_member_agency").on(t.agency),
  ],
);

/* ══ GNR (faction organisation + the single permission authority) ═════════════════════════════════
 * Per agency, edited by the direction on the "Accès" page. Design: _server_build/CITADEL_CAD_GNR.md.
 * A RANG groups ESX grades; ROLES are unités/spécialités/habilitations; the GRANT matrix maps a rang
 * or role -> capability codes (capabilities.ts). This is the ONE place; CAD gates on it now, and the
 * game (F6/in-game) + the Discord sync read the SAME grants in later phases.
 */

/** RANG - a named grouping of ESX grades (e.g. "État-Major", "Hommes de rang"). */
export const citadelCadRanks = mysqlTable(
  CT.cadRanks,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    agency: varchar("agency", { length: 32 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    color: varchar("color", { length: 16 }).default("blue").notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_cad_rank_agency").on(t.agency)],
);

/**
 * Which ESX job grades belong to a rang. `grade` is the ESX job_grades.grade number for the agency's
 * job. A grade is in at most one rang per agency (composite PK on agency+grade).
 */
export const citadelCadRankGrades = mysqlTable(
  CT.cadRankGrades,
  {
    agency: varchar("agency", { length: 32 }).notNull(),
    grade: int("grade").notNull(),
    rankId: bigint("rank_id", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agency, t.grade] }),
    index("idx_cad_rank_grade_rank").on(t.rankId),
  ],
);

/** ROLE - a unité / spécialité / habilitation a member can hold (SWAT, K9, Dispatch, …). */
export const citadelCadRoles = mysqlTable(
  CT.cadRoles,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    agency: varchar("agency", { length: 32 }).notNull(),
    category: mysqlEnum("category", ["unit", "specialty", "habilitation"]).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    color: varchar("color", { length: 16 }).default("blue").notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_cad_role_agency").on(t.agency, t.category)],
);

/** Which members hold which role (bare-hex license). */
export const citadelCadMemberRoles = mysqlTable(
  CT.cadMemberRoles,
  {
    agency: varchar("agency", { length: 32 }).notNull(),
    license: varchar("license", { length: 60 }).notNull(),
    roleId: bigint("role_id", { mode: "number" }).notNull(),
    assignedByLicense: varchar("assigned_by_license", { length: 60 }),
    assignedAt: createdNow("assigned_at"),
  },
  (t) => [
    primaryKey({ columns: [t.license, t.roleId] }),
    index("idx_cad_member_role_role").on(t.roleId),
    index("idx_cad_member_role_agency").on(t.agency),
  ],
);

/**
 * THE GRANT MATRIX - a rang or a role -> a capability code (capabilities.ts). The single authority a
 * member's effective capabilities are unioned from. `subjectType` says whether subjectId is a rank id
 * or a role id.
 */
export const citadelCadGrants = mysqlTable(
  CT.cadGrants,
  {
    agency: varchar("agency", { length: 32 }).notNull(),
    // 'rank' = a rang id, 'role' = a unité/spécialité/habilitation id, 'grade' = an ESX grade NUMBER.
    // A member's effective capabilities are unioned across their grade, their grade's rang, and every
    // rôle they hold - so a permission can be pinned to one specific grade without making it a rang.
    subjectType: mysqlEnum("subject_type", ["rank", "role", "grade"]).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    capability: varchar("capability", { length: 48 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agency, t.subjectType, t.subjectId, t.capability] }),
    index("idx_cad_grant_subject").on(t.subjectType, t.subjectId),
  ],
);

/**
 * MATRICULE - an agency's badge number for one member, set by the direction on the "Accès" page.
 *
 * ⚠ It is a table, NOT a column on `citadel_cad_presence`, and that is the whole design. Presence is
 * the duty LEASE: game-written, expiring, and deleted on every off-duty (`CITADEL/server/
 * cad_presence.lua`). A matricule outlives the shift, so storing it there would silently hand the
 * same number back to the pool the moment its holder clocked off.
 *
 * PK(agency, license) = at most ONE matricule per person per agency (a second character of the same
 * player is a different license, and legitimately a different officer). The unique index on
 * (agency, matricule) is the "cannot be given to anyone else" rule, enforced by the DATABASE rather
 * than a read-then-write in the action: two managers assigning the same number at the same moment
 * both pass a check-then-insert, and only a unique key makes the loser fail. The number is stored
 * exactly as typed (trimmed) but uniqueness rides on the column's case-insensitive collation, so
 * "A12" cannot be handed out beside "a12".
 */
export const citadelCadMatricules = mysqlTable(
  CT.cadMatricules,
  {
    agency: varchar("agency", { length: 32 }).notNull(),
    license: varchar("license", { length: 60 }).notNull(), // bare hex, joins users.identifier
    matricule: varchar("matricule", { length: 16 }).notNull(),
    assignedByLicense: varchar("assigned_by_license", { length: 60 }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.agency, t.license] }),
    uniqueIndex("uq_cad_matricule_agency").on(t.agency, t.matricule),
  ],
);

/**
 * WHY CITADEL CANNOT CURRENTLY RENAME ONE MEMBER IN ONE GUILD.
 *
 * ⚠ STATE, NOT AN EVENT LOG, and that distinction is the whole reason it exists. A nickname refusal
 * is PERMANENT by construction (the sync handler rethrows everything transient), so it is identically
 * true on every one of the sweep's runs. That leaves two bad options and this table is the third:
 * auditing it every time writes the same unactionable row every 15 minutes forever, and auditing it
 * only when a human just clicked means the failure is observable ONLY inside an 8 second poll in the
 * browser tab of whoever happened to be looking. Nobody ever learns that the bot cannot rename the
 * direction team - which is precisely the group whose Discord role tends to sit above the bot's.
 *
 * One row per (account, guild) that is currently broken. The bot UPSERTs on every sync and DELETEs
 * the instant the rename succeeds, so it never grows, self-clears with no sweeper, and a stale row
 * is impossible: it is rewritten or removed on the very next reconcile. The Accès roster renders it
 * permanently on the member's line, which is the panel's own rule that a blocked action is shown and
 * explained rather than hidden.
 *
 * No FK on `account_id`/`guild_id` deliberately: a deleted account or a guild the bot left must make
 * the row inert, not break the sync that was trying to report it.
 */
export const citadelDiscordNicknameFailures = mysqlTable(
  CT.discordNicknameFailures,
  {
    accountId: int("account_id").notNull(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    /** French, already player-readable: this is rendered to the direction verbatim. */
    reason: varchar("reason", { length: 255 }).notNull(),
    /** The badge in play when it failed, or NULL for a plain RP-name sync. Context for the roster. */
    matricule: varchar("matricule", { length: 16 }),
    /** What CITADEL wanted the nickname to be, so the direction can see what they are missing. */
    desired: varchar("desired", { length: 64 }),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.guildId] }),
    index("idx_discord_nickname_failures_guild").on(t.guildId),
  ],
);

/**
 * A CAD rang or rôle linked to a Discord role the bot manages. Read as: "a member whose grade maps to
 * rang `subjectId` (subjectType='rank'), or who holds rôle `subjectId` (subjectType='role'), in
 * `agency` should hold `roleId` in `guildId`, and should NOT hold any other role in this table for
 * that guild." A grade inherits its rang's role through citadel_cad_rank_grades - grades are never
 * linked directly.
 *
 * Mirrors citadel_discord_rank_roles (staff) - same strip-set safety model in discordSync.ts - and is
 * the CAD half of that engine. `guildId` is always one of the STAFF-managed guilds
 * (citadel_discord_guilds.managed): CAD managers only ever pick a ROLE from an already-managed guild,
 * never link a guild themselves (owner rule: guild linking is Fondateur/staff-only). No FK to
 * citadel_cad_ranks/roles - a deleted subject's mapping is simply inert (same reasoning as the
 * rank-role table's cross-owner-FK note above).
 */
export const citadelDiscordCadRoles = mysqlTable(
  CT.discordCadRoles,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    agency: varchar("agency", { length: 32 }).notNull(),
    // 'grade' links an ESX grade NUMBER directly to a role (subjectId = the grade); 'rank' links a
    // rang id; 'role' links a unité/spécialité/habilitation id. A grade already inherits its rang's
    // role via citadel_cad_rank_grades, so 'grade' is an ADDITIONAL, direct link on top of that.
    subjectType: mysqlEnum("subject_type", ["rank", "role", "grade"]).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    roleId: varchar("role_id", { length: 32 }).notNull(),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    uniqueIndex("uq_cad_discord_role").on(t.agency, t.subjectType, t.subjectId, t.guildId, t.roleId),
    // The sync engine's hot read is "every managed CAD role in this guild" (the strip set).
    index("idx_cad_discord_role_guild").on(t.guildId),
    index("idx_cad_discord_role_subject").on(t.agency, t.subjectType, t.subjectId),
  ],
);

/**
 * WHICH DISCORD SERVERS AN AGENCY OWNS, AND WHICH OF THEM IT RENAMES IN. Owner request 2026-08-20:
 * "rename all lspd agents for all discord server chosen to rename ... in cad access page ... for any
 * checklist server citadel bot is in".
 *
 * ⚠ IT REPLACES `citadel_discord_guilds.cad_agency` AS THE SOURCE OF TRUTH. That column is a single
 * varchar on the GUILD row, so it can name exactly one agency per server - and the owner decided a
 * server may serve SEVERAL (a shared law-enforcement Discord hosting LSPD and BCSO at once). A
 * many-to-many fact cannot be stored on either side's row; it needs its own table. The column is
 * still on disk, backfilled from, and now read by nothing (see its own comment).
 *
 * ⚠⚠ TWO DIFFERENT AUTHORITIES LIVE IN ONE ROW, ON PURPOSE, AND THEY MUST NOT BE COLLAPSED:
 *
 *   the ROW EXISTING  = "this server belongs to this agency". A FONDATEUR decides this, on the staff
 *                       Discord page (`discord.manage`). It is the permission boundary the 2026-08-09
 *                       owner rule rests on: it is what lets an LSPD manager link roles here and
 *                       keeps them out of every other faction's server. A direction that could
 *                       create its own row would simply declare the main GrandSide guild its own.
 *   `rename_enabled`  = "and we want our matricules worn here". The agency's OWN DIRECTION ticks
 *                       this, from the CAD Accès page. It can only ever narrow what a Fondateur
 *                       already granted, so it is safe in a faction's hands (owner decision
 *                       2026-08-20: "direction ticks its own servers only").
 *
 * Defaults TRUE because that is what binding a server already meant before this table existed:
 * a Fondateur bound a guild and renames started there. A `false` default would have made the
 * migration a silent, community-wide behaviour change - every badge quietly stopping at once.
 *
 * No FK to either side, same reasoning as citadel_discord_cad_roles: agencies live in TypeScript
 * (agencies.ts), and a guild row can be removed by a discovery pass. A dangling row must degrade to
 * "matches nobody" rather than break a delete.
 */
export const citadelCadGuilds = mysqlTable(
  CT.cadGuilds,
  {
    agency: varchar("agency", { length: 32 }).notNull(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    /** Does this agency's matricule get worn in this server. Ticked by the agency's own direction. */
    renameEnabled: boolean("rename_enabled").default(true).notNull(),
    /** The account that bound the server (Fondateur). Provenance for an unbind that surprises someone. */
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.agency, t.guildId] }),
    // The sync engine's hot read is the other direction entirely: "which agencies does THIS guild
    // serve", once per guild on every desired-state computation.
    index("idx_cad_guilds_guild").on(t.guildId),
  ],
);

/**
 * Player playtest / bug reports from Discord @mention (ALL players, not staff-only).
 * Distinct from citadel_reports (in-game /report) and citadel_tickets (Discord support queue).
 * The bot is the ONLY writer of these tables for this feature.
 *
 * Design: citadel/_server_build/SESSION_2026-07-20_playtest_reports.md
 */
export const citadelPlaytestReports = mysqlTable(
  CT.playtestReports,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** Public quoteable ref, e.g. #PT-A3F9. Random, not sequential (same reason as tickets). */
    publicRef: varchar("public_ref", { length: 16 }).notNull(),
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    discordUsername: varchar("discord_username", { length: 64 }),
    discordMessageId: varchar("discord_message_id", { length: 32 }).notNull(),
    discordChannelId: varchar("discord_channel_id", { length: 32 }).notNull(),
    discordGuildId: varchar("discord_guild_id", { length: 32 }).notNull(),
    /** Discord jump URL for staff; message link, not permanent media storage. */
    messageUrl: varchar("message_url", { length: 255 }),
    /** CITADEL account when Discord is linked; null = unlinked player (still accepted). */
    accountId: bigint("account_id", { mode: "number" }),
    /** Bare-hex license when a character could be resolved; never a Steam username. */
    identifier: varchar("identifier", { length: 60 }),
    /** RP "Firstname Lastname", or null when unlinked / no character. */
    characterName: varchar("character_name", { length: 120 }),
    rawText: text("raw_text").notNull(),
    /** Catalog key from STATUS_BOARD clustering (e.g. fleeca, atm_robbery, other). */
    canonicalKey: varchar("canonical_key", { length: 64 }).notNull(),
    /** French short label for the UI cluster header. */
    canonicalLabel: varchar("canonical_label", { length: 120 }).notNull(),
    outcome: mysqlEnum("outcome", ["ok", "bug", "unknown"]).notNull().default("unknown"),
    notes: text("notes"),
    reproSteps: text("repro_steps"),
    /**
     * Discord CDN attachment URLs + filenames. CDN URLs expire; staff should open messageUrl soon.
     * Shape: [{ url, name, contentType? }]
     */
    attachmentUrls: json("attachment_urls").$type<{ url: string; name: string; contentType?: string }[]>(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_playtest_public_ref").on(t.publicRef),
    index("idx_playtest_canonical").on(t.canonicalKey),
    index("idx_playtest_outcome").on(t.outcome),
    index("idx_playtest_discord").on(t.discordId),
    index("idx_playtest_created").on(t.createdAt),
  ],
);

/**
 * Multi-turn playtest intake state, keyed by Discord user (guild channel follow-ups).
 * Intake session WINS over ambiguous mention routing (same idea as ticket sessions).
 */
export const citadelPlaytestSessions = mysqlTable(CT.playtestSessions, {
  discordId: varchar("discord_id", { length: 32 }).primaryKey(),
  reportId: bigint("report_id", { mode: "number" }).notNull(),
  state: mysqlEnum("state", ["await_notes", "await_repro", "await_outcome", "done"]).notNull(),
  guildId: varchar("guild_id", { length: 32 }).notNull(),
  channelId: varchar("channel_id", { length: 32 }).notNull(),
  /** Held text when we asked a clarifying question before committing notes/repro. */
  pendingBody: text("pending_body"),
  updatedAt: createdNow("updated_at"),
});

/* ── Page 10 · SERVEUR - live console, process control, scheduled reboots ─────────────────────────
 *
 * Four tables, two owners, and the split matters:
 *
 *   citadel_server_resources / citadel_server_stats  - GAME-WRITTEN. CITADEL migrates them, then
 *     never writes a row. CITADEL/server/servercontrol.lua upserts a full snapshot each heartbeat
 *     tick. A write from the panel would be silently reverted by the next tick AND would put a number
 *     on screen that the game never reported, which is the one thing this page must never do.
 *
 *   citadel_server_schedules / citadel_server_events - CITADEL-WRITTEN, end to end. The game has no
 *     idea these exist.
 */

/**
 * Every resource the live FXServer knows about, and its state, as of the last heartbeat.
 *
 * FULL SNAPSHOT, not an append log: the writer upserts every resource each tick and prunes names that
 * no longer exist, so this table always describes NOW. `updated_at` is therefore the freshness of the
 * READING, not of a change - a row whose `updated_at` is minutes old means the heartbeat stopped, not
 * that the resource has been quiet. The panel reads that difference and says "données périmées"
 * rather than presenting a stale state as current.
 *
 * `name` is the primary key, so there is no id cursor to poll - see lib/realtime/serverLive.ts for
 * why this surface gets a snapshot-diff poller instead of ensurePoller().
 */
export const citadelServerResources = mysqlTable(
  CT.serverResources,
  {
    name: varchar("name", { length: 128 }).primaryKey(),
    /** FXServer's own word: 'started' | 'stopped' | 'starting' | 'stopping' | 'uninitialized' | 'missing'. */
    state: varchar("state", { length: 32 }).notNull(),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [index("idx_server_resources_updated").on(t.updatedAt)],
);

/**
 * ONE row (id = 1), upserted by the game heartbeat. The single place CITADEL can read player count,
 * uptime and resource totals from the GAME's own point of view rather than inferring them.
 *
 * ⚠ `updated_at` is load-bearing, not bookkeeping. Every number here is a snapshot with no
 * self-refresh: if the heartbeat dies, the row keeps saying "42 joueurs" forever. Every reader must
 * check the age before rendering (SERVER_CONTROL_CONFIG.stats.staleMs) - the panel's hard rule is that
 * a stale number is worse than no number, because no number is visibly missing and a stale one is not.
 */
export const citadelServerStats = mysqlTable(CT.serverStats, {
  /** Always 1 - a singleton row, so the upsert has a stable key and the table cannot grow. */
  id: tinyint("id").primaryKey(),
  players: int("players").notNull().default(0),
  maxPlayers: int("max_players").notNull().default(0),
  /** Seconds since the FXServer process came up, as the GAME measures it. */
  uptimeSeconds: int("uptime_seconds").notNull().default(0),
  resourcesTotal: int("resources_total").notNull().default(0),
  resourcesStarted: int("resources_started").notNull().default(0),
  updatedAt: createdNow("updated_at"),
});

/**
 * A scheduled reboot. Read as: "at `hhmm` local time, on every weekday whose bit is set in
 * `days_mask`, restart the server; announce it in game at each offset in `warn_minutes` first."
 *
 * ⚠ LOCAL WALL-CLOCK, DELIBERATELY. `hhmm` is a naive "06:00", not an instant, because that is what
 * the owner means: a 6am reboot stays a 6am reboot across a DST change. The scheduler resolves it
 * against the process's local zone (the same zone MariaDB writes its datetimes in - see db/types.ts),
 * so the two never disagree.
 *
 * ⚠ `days_mask` BIT 0 IS MONDAY, bit 6 Sunday. NOT JavaScript's getDay() (0 = Sunday) and NOT
 * MySQL's DAYOFWEEK() (1 = Sunday). One shared conversion lives in lib/data/serverControlModel.ts;
 * never re-derive it at a call site, it is exactly the kind of off-by-one that reboots the server on
 * the wrong day and looks correct in every test that uses a Wednesday.
 *
 * The three `last_*` columns are the SCHEDULER'S state, not user data - they are what makes the loop
 * survive a panel restart without double-firing. See lib/server/rebootScheduler.ts.
 */
export const citadelServerSchedules = mysqlTable(
  CT.serverSchedules,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    label: varchar("label", { length: 64 }).notNull(),
    /** "HH:MM", 24h, local wall-clock. char(5) so a malformed value cannot even be stored. */
    hhmm: varchar("hhmm", { length: 5 }).notNull(),
    /** Bit 0 = Monday … bit 6 = Sunday. 0 = no day, which means the schedule never fires. */
    daysMask: tinyint("days_mask").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    /** Minutes before T-0 to announce, e.g. [15, 5, 1]. Sorted/deduped on write. */
    warnMinutes: json("warn_minutes").$type<number[]>().notNull(),
    /** Shown to players in the announcement and stored on the resulting citadel_server_events row. */
    reason: varchar("reason", { length: 255 }),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
    /**
     * The SLOT this schedule has already handled (not "when we fired") - so a comparison against the
     * slot being considered is exact, and a panel that boots twice in the same minute cannot fire the
     * same 06:00 twice. Set on create/edit to the most recent PAST slot, which is what stops enabling
     * a 06:00 schedule at 06:05 from rebooting the server five minutes later.
     */
    lastFiredAt: nullableDate("last_fired_at"),
    /** The slot the warnings below belong to. Pairs with lastWarnMinute; meaningless alone. */
    lastWarnSlot: nullableDate("last_warn_slot"),
    /**
     * The SMALLEST warn offset already announced for `last_warn_slot`. Smallest rather than a list
     * because the offsets are announced in descending order, so one number says "everything at or
     * above this has been said" - and it makes the "panel was down through the 15 and 5 marks, only
     * announce the 1" behaviour a single comparison instead of set arithmetic.
     */
    lastWarnMinute: int("last_warn_minute"),
  },
  (t) => [index("idx_server_schedules_enabled").on(t.enabled)],
);

/**
 * What CITADEL asked the launcher to do, and what happened. Append-only.
 *
 * ⚠ NOT a duplicate of citadel_audit. The audit row records a HUMAN DECISION (who pressed it, with
 * which reason, from which IP) and only exists when a human acted. This records the OUTCOME, and
 * covers the schedule path too - which has no actor, so it would otherwise leave no trace anywhere
 * that the server rebooted itself at 06:00. Both rows are written for a panel-initiated control.
 */
export const citadelServerEvents = mysqlTable(
  CT.serverEvents,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** 'start' | 'stop' | 'restart' | 'schedule.skipped' - free-form on purpose, it is a log. */
    action: varchar("action", { length: 32 }).notNull(),
    source: mysqlEnum("source", ["panel", "schedule"]).notNull(),
    /** null for the schedule path - there is no human to name, and inventing one would be a lie. */
    actorAccountId: bigint("actor_account_id", { mode: "number" }),
    reason: text("reason"),
    /** 'ok' | 'failed' | 'refused' | 'skipped'. */
    status: varchar("status", { length: 16 }).notNull(),
    /** The launcher's own error text when it refused or failed, verbatim. */
    detail: text("detail"),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_server_events_created").on(t.createdAt)],
);

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * JUSTICE CAD - penal code, casier judiciaire, case layer.
 * Design: fivem/server-data/_server_build/JUSTICE_CAD_BUILD_SPEC.md §2. No DB-level FK constraints
 * anywhere in this file (matches the rest of the schema); "FK" comments below name the intended
 * relationship, enforced at the application layer, never a `.references()` call.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── 2.1 Reference data - seeded from the owner's spreadsheet (scripts/seed-penal.ts), editable
 * in-panel with the `penal.manage` capability. ─────────────────────────────────────────────────── */

/**
 * The 5-level penalty scale (N1 Infraction / N2 Délit / N3 Délit grave / N4 Crime / N5 Crime
 * capital), replacing the old 4-tier C / DM / DMA / CR taxonomy on 2026-08-21 (owner's new
 * "Code pénal - État de San Andreas"). Seeded by `scripts/seed-penal-sa.ts`.
 *
 * The bands are DATA, not documentation: `amendeMin`/`amendeMax` and `prisonMin`/`maxCustodyMinutes`
 * are what the seed validates all 110 infractions against, and what the CAD shows an officer who is
 * deciding a sentence. `casierJours` is chapter 16.2's retention (N1 none, N2 7d, N3 14d, N4 30d,
 * N5 permanent = null).
 *
 * ⚠ N1 and N5 both leave the prison band null, for OPPOSITE reasons: N1 carries no custody at all,
 * N5 carries perpétuité, which is not a minute count. Anything computing a duration must treat them
 * separately - `severityRank` is what tells them apart, never the nullness.
 */
export const citadelPenalTiers = mysqlTable(
  CT.penalTiers,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 8 }).notNull(), // 'N1' | 'N2' | 'N3' | 'N4' | 'N5'
    libelle: varchar("libelle", { length: 64 }).notNull(),
    severityRank: tinyint("severity_rank").notNull(),
    amendeMin: decimal("amende_min", { precision: 12, scale: 2, mode: "number" }),
    amendeMax: decimal("amende_max", { precision: 12, scale: 2, mode: "number" }),
    prisonMin: int("prison_min"),
    custodyFacility: mysqlEnum("custody_facility", ["none", "gav", "bolingbroke"]).notNull(),
    /** Upper bound of the prison band. Null for N1 (no custody) and N5 (perpétuité). */
    maxCustodyMinutes: int("max_custody_minutes"),
    /** "Amende sur place, pas de casier", "Réquisition du procureur", ... */
    traitement: varchar("traitement", { length: 200 }),
    /** Chapter 16.2 retention in real days. 0 = never recorded (N1), null = permanent (N5). */
    casierJours: int("casier_jours"),
    casierConsultablePar: varchar("casier_consultable_par", { length: 255 }),
    policyNote: text("policy_note"),
    recidiveNote: text("recidive_note"),
    sortOrder: tinyint("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("uq_penal_tier_code").on(t.code)],
);

/**
 * The 7 domains the new code is classified by (RT route, OP ordre public, PS personnes, BN biens,
 * AS armes/stupéfiants, AJ autorité/justice, CX crimes capitaux).
 *
 * ⚠ A DOMAIN IS NOT A TIER, and conflating the two is the single most likely mistake here. The old
 * code's prefix WAS its tier; this one's prefix is its domain, and one domain spans several levels
 * (PS holds N2, N3 and N4 infractions). Any code that reads a tier out of an infraction code's
 * prefix is wrong - read `citadelPenalCode.tierId`, or for an already-written charge its own
 * `tierSnapshot` column.
 */
export const citadelPenalDomains = mysqlTable(
  CT.penalDomains,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 8 }).notNull(), // 'RT' | 'OP' | 'PS' | 'BN' | 'AS' | 'AJ' | 'CX'
    libelle: varchar("libelle", { length: 64 }).notNull(),
    note: text("note"),
    sortOrder: tinyint("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("uq_penal_domain_code").on(t.code)],
);

/**
 * The 110 infractions of the San Andreas code (2026-08-21), keyed `<DOMAIN>-<NN>` and carrying BOTH
 * a `domainId` (what it is about) and a `tierId` (how severely it is punished). Those are two
 * independent axes - see the warning on `citadelPenalDomains`.
 *
 * `custodyMinutes` is the tabled prison time in minutes (null where the level carries none, i.e.
 * every N1, and every N5 where the sentence is perpétuité rather than a duration).
 * `custodyFacility` follows the LEVEL, not the row: none for N1, gav for N2/N3 (cellules du poste),
 * bolingbroke for N4/N5 - chapter 16.1.
 *
 * `mesure` is the source's "Mesure associée" column - a side-effect of the conviction that is NOT a
 * sentence ("Fourrière", "Saisie + PPA suspendu", "Permis retiré", "Gel des comptes 7 j"). It is
 * deliberately its own column rather than folded into `sentenceLabel`: an officer applies it
 * separately from the fine and the cell time.
 *
 * `sentenceLabel` keeps the human-readable sentence string ("Aucune", "25 min", "PERPÉTUITÉ").
 * `prescriptionYears` is still not in the source - nullable, owner fills later, no sweeper reads it.
 */
export const citadelPenalCode = mysqlTable(
  CT.penalCode,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 12 }).notNull(), // 'RT-01', 'PS-16', 'CX-08', ...
    tierId: bigint("tier_id", { mode: "number" }).notNull(), // FK citadel_penal_tiers.id
    domainId: bigint("domain_id", { mode: "number" }), // FK citadel_penal_domains.id
    libelle: varchar("libelle", { length: 200 }).notNull(),
    amende: decimal("amende", { precision: 12, scale: 2, mode: "number" }).notNull(),
    sentenceLabel: varchar("sentence_label", { length: 64 }).notNull(),
    custodyMinutes: int("custody_minutes"),
    custodyFacility: mysqlEnum("custody_facility", ["none", "saisie", "gav", "bolingbroke"]).notNull(),
    noteApplication: text("note_application"),
    /** The source's "Mesure associée" column. */
    mesure: varchar("mesure", { length: 120 }),
    prescriptionYears: int("prescription_years"),
    active: boolean("active").default(true).notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_penal_code_code").on(t.code),
    index("idx_penal_code_tier").on(t.tierId),
    index("idx_penal_code_domain").on(t.domainId),
    index("idx_penal_code_active").on(t.active),
  ],
);

/**
 * Chapter 3, "Répartition des compétences par niveau" - the responsibility matrix, now 9 steps x 5
 * levels = 45 cells. This is the workflow engine: nothing in the UI may hardcode "an N4 needs the
 * procureur", it reads this table.
 *
 * ⚠ The source prints the matrix with FOUR columns because it merges N2 and N3 into one ("N2 - N3").
 * The seed DEPLIES that column into one row per level, so this table always has a row for every
 * (step, level) pair and a caller never has to know which levels the paper document happened to
 * group. Do not re-merge them: they are separate tiers everywhere else in the schema.
 *
 * `authority` gained three values with this code: `impossible` (an N5 arrangement does not exist),
 * `cour_assises` (who decides an N5 sentence) and `juge_autre` (an appeal is never heard by the
 * judge who ruled - chapter 13.4).
 */
export const citadelPenalProcedure = mysqlTable(
  CT.penalProcedure,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    stepKey: varchar("step_key", { length: 32 }).notNull(),
    stepLibelle: varchar("step_libelle", { length: 120 }).notNull(),
    tierId: bigint("tier_id", { mode: "number" }).notNull(), // FK citadel_penal_tiers.id
    authority: mysqlEnum("authority", [
      "police",
      "procureur",
      "juge",
      "na",
      "impossible",
      "cour_assises",
      "juge_autre",
    ]).notNull(),
    footnoteId: bigint("footnote_id", { mode: "number" }), // FK citadel_penal_footnotes.id
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("uq_penal_procedure_step_tier").on(t.stepKey, t.tierId),
    index("idx_penal_procedure_tier").on(t.tierId),
  ],
);

/** The 3 conditional rules attached to matrix cells by marker (outrage exception, 72h appeal window
 * with no-self-review, contumace summons). */
export const citadelPenalFootnotes = mysqlTable(
  CT.penalFootnotes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    marker: varchar("marker", { length: 4 }).notNull(), // '*' | '**' | '***'
    body: text("body").notNull(),
  },
  (t) => [uniqueIndex("uq_penal_footnote_marker").on(t.marker)],
);

/**
 * Chapter 11's 4 warrant types (perquisition / arret / comparution / saisie). `minInfractions` and
 * `allowsFlagranceException` are the "must cite at least 2 infractions" / flagrance-exception rules
 * as data, not prose.
 *
 * `validiteMinutes` is a REAL-TIME window, not in-game time, and it is short enough to matter: a
 * saisie warrant dies after 30 minutes. `validiteLabel` keeps the source wording ("24 h réelles")
 * because that is what an officer reads off the form. `formulaire` names the owner's printable court
 * form where one exists (SA-442 arrest, SA-093 search).
 *
 * ⚠ KNOWN CONFLICT between the owner's own two documents, left as the reference document has it and
 * flagged rather than silently reconciled: the Système judiciaire (chapter 11) gives Perquisition
 * "24 h réelles", while the SA-093 form itself is headed "VALABLE 30 MINUTES". The reference
 * document is what is seeded. Owner decision pending.
 */
export const citadelWarrantTypes = mysqlTable(
  CT.warrantTypes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 24 }).notNull(), // 'perquisition' | 'arret' | 'comparution' | 'saisie'
    libelle: varchar("libelle", { length: 80 }).notNull(),
    explication: text("explication"),
    /** 'juge' | 'procureur' | 'juge_ou_procureur' */
    delivrePar: varchar("delivre_par", { length: 32 }),
    validiteMinutes: int("validite_minutes"),
    validiteLabel: varchar("validite_label", { length: 32 }),
    /** The mandatory-content list the warrant is void without. */
    contenu: text("contenu"),
    formulaire: varchar("formulaire", { length: 16 }),
    minInfractions: tinyint("min_infractions").default(2).notNull(),
    allowsFlagranceException: boolean("allows_flagrance_exception").default(false).notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("uq_warrant_type_code").on(t.code)],
);

/** The "Vice de procedure" reference, blocks 1 and 2 (defect by procedural act, and vice de forme on
 * reports/summons). `consequenceId` links a defect to the closed outcome set below when the source
 * sheet names one. */
export const citadelProcedureDefects = mysqlTable(
  CT.procedureDefects,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    block: mysqlEnum("block", ["acte", "forme"]).notNull(),
    acteLibelle: varchar("acte_libelle", { length: 160 }).notNull(),
    /**
     * Chapter 12's "Portée" column, and the whole point of that chapter: `totale` means the dossier
     * falls entirely, `partielle` means only the tainted element is excluded and the case survives.
     * Nullable only for rows predating the San Andreas code.
     */
    portee: mysqlEnum("portee", ["totale", "partielle"]),
    baseControle: text("base_controle"),
    elements: text("elements"),
    consequenceId: bigint("consequence_id", { mode: "number" }), // FK citadel_procedure_consequences.id
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [
    index("idx_procedure_defect_block").on(t.block),
    index("idx_procedure_defect_consequence").on(t.consequenceId),
  ],
);

/** The "Vice de procedure" block 3 - the closed set of 5 outcomes. `effect` is the machine-readable
 * action a raised defect can trigger (revoke a casier entry, invalidate a warrant, ...), which is what
 * lets a defect actually DO something rather than just being a note. */
export const citadelProcedureConsequences = mysqlTable(
  CT.procedureConsequences,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 32 }).notNull(),
    libelle: varchar("libelle", { length: 120 }).notNull(),
    explication: text("explication"),
    effect: mysqlEnum("effect", [
      "none",
      "revoke_entry",
      "invalidate_warrant",
      "exclude_evidence",
      "postpone_hearing",
    ])
      .default("none")
      .notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("uq_procedure_consequence_code").on(t.code)],
);

/**
 * The aggravating / mitigating circumstances that modify a tabled sentence (+25 % firearm, +25 %
 * organised group, +25 % victim is an agent/magistrate/EMS/minor, +5 min flight or rebellion,
 * -25 % immediate full confession, -25 % restitution).
 *
 * ⚠ Two DIFFERENT units live in this table and a caller must not add them together: `effetPct` is a
 * percentage applied to BOTH the fine and the custody time, `effetMinutes` is a flat addition to
 * custody only. Exactly one of the two is set per row. The running total is itself capped
 * (+50 % / -50 %, `citadelPenalRules`), and the 75-minute prison ceiling applies after everything.
 */
export const citadelPenalCircumstances = mysqlTable(
  CT.penalCircumstances,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    libelle: varchar("libelle", { length: 160 }).notNull(),
    sens: mysqlEnum("sens", ["aggravante", "attenuante"]).notNull(),
    effetPct: int("effet_pct"),
    effetMinutes: int("effet_minutes"),
    precision: text("precision"),
    sortOrder: int("sort_order").default(0).notNull(),
  },
);

/** The source's "Barème rapide de terrain" - worked examples an officer can copy on a traffic stop
 * rather than recomputing a cumul from scratch. Pure reference; nothing computes from it. */
export const citadelPenalFieldGuide = mysqlTable(
  CT.penalFieldGuide,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    situation: varchar("situation", { length: 200 }).notNull(),
    codes: varchar("codes", { length: 120 }).notNull(),
    amende: decimal("amende", { precision: 12, scale: 2, mode: "number" }).notNull(),
    prisonMin: int("prison_min"),
    note: varchar("note", { length: 64 }),
    sortOrder: int("sort_order").default(0).notNull(),
  },
);

/**
 * The 8 "Règles d'application" and the 2 hard caps, in one keyed table.
 *
 * The caps carry a `numericValue` because they are ENFORCED, not merely displayed: 75 minutes of
 * prison and 80 000 $ per affaire are ceilings no cumul may exceed. Keyed (`plafond_prison`,
 * `plafond_amende`, `regle_01`...) so a caller asks by name rather than by row order.
 */
export const citadelPenalRules = mysqlTable(
  CT.penalRules,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    ruleKey: varchar("rule_key", { length: 48 }).notNull(),
    kind: mysqlEnum("kind", ["regle", "plafond"]).default("regle").notNull(),
    libelle: varchar("libelle", { length: 160 }),
    body: text("body"),
    numericValue: int("numeric_value"),
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("uq_penal_rule_key").on(t.ruleKey)],
);

/**
 * THE CODE PÉNAL'S OWN LEDGER (2026-08-25). Every write on the seven reference tables lands here
 * with FULL before/after row snapshots, which buys three things at once:
 *
 *   - the log the owner asked for ("with logs ofc"), naming the magistrate, their agency and whether
 *     they acted through the Fondateur staff override rather than a faction grant;
 *   - the undo ("undoable by staff in citadel staff") - `before` is literally what to write back;
 *   - the ARCHIVE ("it doesnt acc delete its like acheiving") - a row removed from a reference table
 *     is preserved here in full, with its original id, and can be put back exactly as it was.
 *
 * ⚠ An INFRACTION is never row-deleted at all: `deleteInfraction` sets `active = false` and records
 * `action = 'archive'`. That is stricter than the other six kinds, and deliberately so - an
 * infraction is what filed charges and casier entries point at by id, so its row disappearing is the
 * one removal here that could orphan a real person's record.
 *
 * `targetKey` is the human handle (an infraction code, a step key, a tier code), stored so the feed
 * still reads correctly when the row itself is gone.
 */
export const citadelPenalRevisions = mysqlTable(
  CT.penalRevisions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    targetKind: mysqlEnum("target_kind", [
      "infraction",
      "tier",
      "procedure_step",
      "footnote",
      "warrant_type",
      "consequence",
      "defect",
    ]).notNull(),
    /** Null for `procedure_step`, which is keyed by `targetKey` and spans one row per tier. */
    targetId: bigint("target_id", { mode: "number" }),
    targetKey: varchar("target_key", { length: 64 }).notNull(),
    targetLabel: varchar("target_label", { length: 200 }),
    action: mysqlEnum("action", ["create", "update", "archive", "restore", "delete"]).notNull(),
    /** Raw row(s) as they stood before the write. Null on a creation.
     *  `parsedJson` for the same reason the casier ledger's `diff` uses it - see that column. */
    before: parsedJson<unknown>()("before"),
    /** Raw row(s) as they stand after it. Null on a deletion. */
    after: parsedJson<unknown>()("after"),
    actorLicense: varchar("actor_license", { length: 60 }),
    actorName: varchar("actor_name", { length: 120 }).notNull(),
    actorAgency: varchar("actor_agency", { length: 16 }),
    actorAccountId: bigint("actor_account_id", { mode: "number" }),
    /** The write came through CODES.JUSTICE_PENAL_MANAGE (Fondateur), not a `penal.manage` grant. */
    viaStaff: boolean("via_staff").default(false).notNull(),
    createdAt: createdNow("created_at"),
    undoneAt: nullableDate("undone_at"),
    undoneByAccountId: bigint("undone_by_account_id", { mode: "number" }),
    undoReason: varchar("undo_reason", { length: 255 }),
  },
  (t) => [
    index("idx_penal_revision_recent").on(t.createdAt),
    index("idx_penal_revision_target").on(t.targetKind, t.targetId),
  ],
);

/* ── 2.2 Casier judiciaire ────────────────────────────────────────────────────────────────────── */

/**
 * ONE person's rap sheet, one row per event. `authorLicense`/`authorName`/`authorAgency`/
 * `authorGradeLabel` are denormalized on purpose (same convention as citadel_ban_appeals' authorName
 * and citadel_player_notes' authorName/authorRank above): "CREE PAR" must still render correctly years
 * later even after the author has left the faction. `montantTotal` is the server-recomputed sum of
 * citadel_casier_entry_charges (amende_applied * count) - never accepted from the client. The revoke
 * block and the staff-purge block are two independent, append-only lifecycle transitions off `active`:
 * `visibility='revoked'` is a judge/vice-de-procedure action (player-visible reason), `visibility=
 * 'staff_deleted'` is CITADEL oversight only (gated on `justice.casier.purge`, staff-route reversible).
 */
export const citadelCasierEntries = mysqlTable(
  CT.casierEntries,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(), // prefix "CJ-" (§2.4)
    personIdentifier: varchar("person_identifier", { length: 60 }).notNull(), // bare hex, joins users.identifier
    entryType: mysqlEnum("entry_type", ["arrestation", "information", "jugement", "effacement", "vente_arme"]).notNull(),
    visibility: mysqlEnum("visibility", ["active", "revoked", "staff_deleted"]).default("active").notNull(),
    occurredAt: datetime("occurred_at", { mode: "date" }).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
    authorLicense: varchar("author_license", { length: 60 }).notNull(),
    authorName: varchar("author_name", { length: 80 }).notNull(), // RP name, resolved at write time
    authorAgency: varchar("author_agency", { length: 16 }).notNull(),
    authorGradeLabel: varchar("author_grade_label", { length: 64 }),
    comment: text("comment"),
    montantTotal: decimal("montant_total", { precision: 12, scale: 2, mode: "number" }).default(0).notNull(),
    custodyMinutes: int("custody_minutes").default(0).notNull(),
    custodyFacility: mysqlEnum("custody_facility", ["none", "saisie", "gav", "bolingbroke"]),
    avocat: varchar("avocat", { length: 120 }),
    // Weapon sale entries only (entry_type = 'vente_arme'). Indexed below so Recherche can resolve a
    // serial number straight to the buyer - "sold, to whom, when" is the entire point of this field.
    weaponSerial: varchar("weapon_serial", { length: 64 }),
    caseId: bigint("case_id", { mode: "number" }), // FK citadel_justice_cases.id
    version: int("version").default(1).notNull(),
    // Revoke block (judge / vice de procedure).
    revokedAt: nullableDate("revoked_at"),
    revokedByLicense: varchar("revoked_by_license", { length: 60 }),
    revokedByName: varchar("revoked_by_name", { length: 120 }),
    revokeReason: text("revoke_reason"),
    revokeDefectId: bigint("revoke_defect_id", { mode: "number" }), // FK citadel_procedure_defects.id
    // Staff purge block (CITADEL oversight, `justice.casier.purge`).
    deletedAt: nullableDate("deleted_at"),
    deletedByAccountId: bigint("deleted_by_account_id", { mode: "number" }),
    deleteReason: text("delete_reason"),
  },
  (t) => [
    uniqueIndex("uq_casier_entry_ref").on(t.publicRef),
    index("idx_casier_entry_person").on(t.personIdentifier, t.visibility, t.occurredAt),
    index("idx_casier_entry_case").on(t.caseId),
    index("idx_casier_entry_type").on(t.entryType),
    index("idx_casier_entry_weapon_serial").on(t.weaponSerial),
  ],
);

/**
 * The multi-select INFRACTIONS on one entry. `codeSnapshot`/`libelleSnapshot` are load-bearing: the
 * penal code is editable in-panel, and an already-written entry must render the charge as it was
 * written, not as the code reads today.
 */
export const citadelCasierEntryCharges = mysqlTable(
  CT.casierEntryCharges,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entryId: bigint("entry_id", { mode: "number" }).notNull(), // FK citadel_casier_entries.id, cascade
    penalCodeId: bigint("penal_code_id", { mode: "number" }).notNull(), // FK citadel_penal_code.id
    codeSnapshot: varchar("code_snapshot", { length: 12 }).notNull(),
    /**
     * ⚠ ADDED 2026-08-21 AND IT IS A CORRECTNESS FIX, NOT A CONVENIENCE COLUMN.
     *
     * This used to be derived from `codeSnapshot`'s prefix ("DMA-12" -> "DMA"), because in the old
     * penal code the prefix WAS the tier. Under the San Andreas code the prefix is a DOMAIN and a
     * domain spans several levels (PS holds N2, N3 and N4), so that derivation is not stale - it is
     * undecidable. The original reasoning for not joining the live `citadel_penal_code` row still
     * stands in full (the code is editable in-panel, and re-deriving would retroactively rewrite a
     * historical entry's tier), so the tier is SNAPSHOT here at write time instead.
     *
     * Nullable only to let the migration apply to pre-existing rows; every new write fills it, and a
     * null renders as a blank category cell rather than a wrong one.
     */
    tierSnapshot: varchar("tier_snapshot", { length: 8 }),
    libelleSnapshot: varchar("libelle_snapshot", { length: 200 }).notNull(),
    amendeApplied: decimal("amende_applied", { precision: 12, scale: 2, mode: "number" }).notNull(),
    custodyMinutesApplied: int("custody_minutes_applied").default(0).notNull(),
    count: tinyint("count").default(1).notNull(),
    /**
     * ⚠ ADDED 2026-08-25. This LINE's fine and custody were typed by a magistrate, they are not the
     * code pénal's own figures (owner: "procureur et justice should be able to modify facture amount
     * and peine per infractions").
     *
     * It is not cosmetic. `amendeApplied` has always been a snapshot, so a hand-set 500 $ on an
     * infraction the code prices at 3 000 $ is BYTE-IDENTICAL to a charge written back when the code
     * priced it at 500 $ - the two readings ("the judge reduced it" and "the law changed since")
     * cannot be told apart from the row, and they mean opposite things to whoever reads the rap
     * sheet. This column is what separates them, which is the same job the neighbouring `*_snapshot`
     * columns do for the code and the tier.
     *
     * Only a `casier.edit` holder can ever set it - see casierActions.ts, which drops the per-charge
     * amounts entirely for a police/sheriff caller rather than trusting them.
     */
    overridden: boolean("overridden").default(false).notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
  },
  (t) => [
    index("idx_casier_charge_entry").on(t.entryId),
    index("idx_casier_charge_penal_code").on(t.penalCodeId),
  ],
);

/**
 * THE LIFECYCLE LEDGER of a casier entry, append-only. `diff` carries only the before/after of the
 * fields that changed, never a full row snapshot.
 *
 * ⚠ WIDENED 2026-08-25 FROM "edit history" TO EVERY LIFECYCLE EVENT, and the diff shape changed with
 * it (owner: "with logs ofc and undoable by staff in citadel staff"). Two things follow:
 *
 *   1. `kind` says WHAT happened - creation, modification, revocation by a judge, lifting of that
 *      revocation, staff archive/restore, or a staff undo. Before this, a revocation left no row
 *      here at all and the history read as if nothing had happened to the entry.
 *   2. `diff.charges` now carries the FULL charge rows on both sides, not the old
 *      `["RT-01x1", ...]` display strings. That is what makes an undo possible: a label cannot be
 *      turned back into a `penal_code_id`, an applied amount and an override flag, so the old shape
 *      recorded that something changed while destroying the ability to put it back.
 *
 * `undone_at` / `undone_by_account_id` mark a revision a staff member has already rolled back. A
 * revision is undoable exactly once, and only while it is the entry's most recent one - undoing an
 * older revision underneath a newer one would silently discard the newer change.
 */
export const citadelCasierEntryRevisions = mysqlTable(
  CT.casierEntryRevisions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entryId: bigint("entry_id", { mode: "number" }).notNull(), // FK citadel_casier_entries.id
    version: int("version").notNull(),
    kind: mysqlEnum("kind", ["create", "edit", "revoke", "unrevoke", "purge", "unpurge", "staff_undo"])
      .default("edit")
      .notNull(),
    changedByLicense: varchar("changed_by_license", { length: 60 }).notNull(),
    changedByName: varchar("changed_by_name", { length: 120 }).notNull(),
    /** Set when the change came from the CITADEL staff panel rather than from a CAD character. */
    actorAccountId: bigint("actor_account_id", { mode: "number" }),
    changedAt: createdNow("changed_at"),
    /**
     * ⚠ `parsedJson`, NOT `json`. mysql2 on MariaDB hands a JSON column back as a STRING, and this
     * ledger is now READ (the staff history and its undo), not merely written. Under `json()` the
     * diff arrives as text, `"charges" in diff` throws "Cannot use 'in' operator", and the undo dies
     * on the one row it exists to fix. Caught by `npm run verify:justice-undo` against the real DB -
     * a schema-only check cannot see it, because the column type is identical either way.
     */
    diff: parsedJson<Record<string, { before: unknown; after: unknown }>>()("diff").notNull(),
    reason: varchar("reason", { length: 255 }),
    undoneAt: nullableDate("undone_at"),
    undoneByAccountId: bigint("undone_by_account_id", { mode: "number" }),
    undoReason: varchar("undo_reason", { length: 255 }),
  },
  (t) => [
    index("idx_casier_revision_entry").on(t.entryId, t.version),
    index("idx_casier_revision_recent").on(t.changedAt),
  ],
);

/** Built now, renders nothing until R2 lands (JUSTICE_CAD_BUILD_SPEC.md §7). The "Ajouter une piece
 * jointe" affordance stays disabled with an explicit reason until the upload handler exists. */
export const citadelCasierAttachments = mysqlTable(
  CT.casierAttachments,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entryId: bigint("entry_id", { mode: "number" }).notNull(), // FK citadel_casier_entries.id
    uploadId: bigint("upload_id", { mode: "number" }).notNull(), // FK citadel_uploads.id
    caption: varchar("caption", { length: 200 }),
    addedByLicense: varchar("added_by_license", { length: 60 }).notNull(),
    addedAt: createdNow("added_at"),
  },
  (t) => [index("idx_casier_attachment_entry").on(t.entryId)],
);

/* ── 2.3 Justice objects - the case layer, rooted on its OWN table. ────────────────────────────────
 *
 * ⚠ THIS BLOCK USED TO OPEN "built ON citadel_cad_incidents (the case root). Not a parallel case
 * table". That was the design until 2026-08-21 and the owner reversed it: "each cad of each job is
 * supposed to be diff not fully linked. the only ones that share the same components are lssd and
 * lspd". A dossier judiciaire is not a dispatch call. Sharing one table meant opening a dossier
 * inserted a row into the police incident feed, a judge's case carried a dispatch priority and an
 * `onscene` status, and `case_id` silently meant "incident id" in eight tables.
 *
 * `citadel_justice_cases` is that root now. It is NOT a copy of the incident table:
 *   - its statuses are judicial (`ouvert` / `instruction` / `audience` / `clos`), not dispatch ones;
 *   - it carries a REVOCATION block, which an incident has no concept of (owner: "justice can remove
 *     a dossier judiciere (not acc deleted but like revoqued)");
 *   - it has no unit-assignment table, because nobody is dispatched to a case file;
 *   - `sourceIncidentId` is the optional one-way link back to the police call that produced it, which
 *     is what "can share some components" looks like when the components are separate.
 *
 * Both tables were EMPTY when this split shipped (COUNT(*) verified against the live DB), so
 * drizzle/0072_justice_split.sql creates them and backfills nothing. That is correct, not an omission.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A JUDICIAL CASE FILE. `version` is bumped on every mutation for optimistic concurrency, the same
 * contract incidents use, so two clerks editing one dossier conflict visibly instead of silently
 * overwriting each other.
 *
 * `visibility` is the revocation: a struck dossier is NEVER deleted. It keeps its ref, its parties,
 * its charges and its timeline, and it keeps rendering - it is stamped, read-only, and carries who
 * struck it and why. Same convention as `citadel_casier_entries`' revoke block, deliberately, so the
 * two judicial "this no longer counts" gestures behave identically.
 */
export const citadelJusticeCases = mysqlTable(
  CT.justiceCases,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Player-quotable, random (not derived from id, which would leak case volume). Prefix "DJ-".
    publicRef: varchar("public_ref", { length: 12 }).notNull(),
    // The agency that OPENED the dossier. Read access is wider than this for justice-family agencies
    // (a judge reaches any case, see justiceCase.ts `canReachCase`) - never widen this column to
    // express that, it is provenance.
    agency: varchar("agency", { length: 32 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    // 1 = urgent, 2 = normal (default), 3 = faible. tinyint, not an enum, so re-tuning the scale is
    // data rather than a migration.
    priority: tinyint("priority").default(2).notNull(),
    status: mysqlEnum("status", ["ouvert", "instruction", "audience", "clos"]).default("ouvert").notNull(),
    location: varchar("location", { length: 200 }),
    // The police call this dossier came out of, when there was one. Nullable and one-way: deleting or
    // closing the incident does nothing to the dossier, and the dossier is readable with the incident
    // gone. This is the ONLY structural link left between the two systems.
    sourceIncidentId: bigint("source_incident_id", { mode: "number" }),
    createdByLicense: varchar("created_by_license", { length: 60 }).notNull(),
    createdByName: varchar("created_by_name", { length: 120 }).notNull(), // RP name, resolved at write time
    closedAt: nullableDate("closed_at"),
    closedByLicense: varchar("closed_by_license", { length: 60 }),
    visibility: mysqlEnum("visibility", ["active", "revoked"]).default("active").notNull(),
    revokedAt: nullableDate("revoked_at"),
    revokedByLicense: varchar("revoked_by_license", { length: 60 }),
    revokedByName: varchar("revoked_by_name", { length: 120 }),
    revokeReason: text("revoke_reason"),
    version: int("version").default(1).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_justice_case_ref").on(t.publicRef),
    index("idx_justice_case_agency").on(t.agency, t.status),
    index("idx_justice_case_status").on(t.status),
    index("idx_justice_case_visibility").on(t.visibility),
    index("idx_justice_case_created").on(t.createdAt),
    index("idx_justice_case_incident").on(t.sourceIncidentId),
  ],
);

/**
 * CASE TIMELINE - append-only, never edited, never deleted. Its own table rather than a `kind` on the
 * incident event log: the two roots have independent id spaces, so one shared events table keyed by a
 * bare id would have silently mixed a dossier's history with a dispatch call's the first time the two
 * sequences overlapped.
 *
 * This log is also the only source of a real timestamp for some case facts, so nothing may prune it.
 */
export const citadelJusticeCaseEvents = mysqlTable(
  CT.justiceCaseEvents,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    kind: varchar("kind", { length: 32 }).notNull(),
    actorLicense: varchar("actor_license", { length: 60 }), // null for system-generated events
    actorName: varchar("actor_name", { length: 120 }),
    body: text("body"),
    data: json("data"),
    createdAt: createdNow("created_at"),
  },
  (t) => [index("idx_justice_case_event_case").on(t.caseId, t.id)],
);

/** A person attached to a case (defendant, victim, witness, counsel). `personIdentifier` is nullable
 * so a witness with no character record is still recordable. */
export const citadelCaseParties = mysqlTable(
  CT.caseParties,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    role: mysqlEnum("role", ["prevenu", "victime", "temoin", "avocat"]).notNull(),
    personIdentifier: varchar("person_identifier", { length: 60 }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    note: text("note"),
    addedByLicense: varchar("added_by_license", { length: 60 }).notNull(),
    addedAt: createdNow("added_at"),
  },
  (t) => [
    index("idx_case_party_case").on(t.caseId, t.role),
    index("idx_case_party_person").on(t.personIdentifier),
  ],
);

/** A charge against one party on a case, versioned independently of the case itself.
 * `requalifiedToId` is a self-FK pointing at the charge a requalification produced. */
export const citadelCaseCharges = mysqlTable(
  CT.caseCharges,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    partyId: bigint("party_id", { mode: "number" }).notNull(), // FK citadel_case_parties.id
    penalCodeId: bigint("penal_code_id", { mode: "number" }).notNull(), // FK citadel_penal_code.id
    codeSnapshot: varchar("code_snapshot", { length: 12 }).notNull(),
    /** See the identical column on `citadelCasierEntryCharges` - the tier can no longer be derived
     * from the code prefix under the San Andreas code, so it is snapshot at write time. */
    tierSnapshot: varchar("tier_snapshot", { length: 8 }),
    libelleSnapshot: varchar("libelle_snapshot", { length: 200 }).notNull(),
    count: tinyint("count").default(1).notNull(),
    status: mysqlEnum("status", ["proposee", "retenue", "abandonnee", "requalifiee"])
      .default("proposee")
      .notNull(),
    requalifiedToId: bigint("requalified_to_id", { mode: "number" }), // self-FK: citadel_case_charges.id
    version: int("version").default(1).notNull(),
    decidedByLicense: varchar("decided_by_license", { length: 60 }),
    decidedAt: nullableDate("decided_at"),
    reason: text("reason"),
    // Added by W3-SCHEMA (JUSTICE_CAD_BUILD_SPEC.md §2.3 gap): the row had no creation timestamp of
    // its own, which forced every caller through the incident event log purely to get one. The event
    // log stays the timeline source of record; this is the row's own timestamp.
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_case_charge_case").on(t.caseId),
    index("idx_case_charge_party").on(t.partyId),
    index("idx_case_charge_penal_code").on(t.penalCodeId),
  ],
);

/** The prosecutor's charging decision on a case. `supersededById` is a self-FK: a later decision on
 * the same case points back at the one it replaced, so the history is never overwritten. */
export const citadelCaseDecisions = mysqlTable(
  CT.caseDecisions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    kind: mysqlEnum("kind", ["poursuite", "classement", "requalification"]).notNull(),
    motif: text("motif"),
    decidedByLicense: varchar("decided_by_license", { length: 60 }).notNull(),
    decidedByName: varchar("decided_by_name", { length: 120 }).notNull(),
    decidedAt: createdNow("decided_at"),
    supersededById: bigint("superseded_by_id", { mode: "number" }), // self-FK: citadel_case_decisions.id
  },
  (t) => [index("idx_case_decision_case").on(t.caseId)],
);

/** The judge's docket. `renvoiOfId` is a self-FK: a continuance points at the hearing it replaces. */
export const citadelCaseHearings = mysqlTable(
  CT.caseHearings,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(), // prefix "AU-" (§2.4)
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    scheduledAt: datetime("scheduled_at", { mode: "date" }).notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    courtroom: varchar("courtroom", { length: 80 }),
    status: mysqlEnum("status", ["prevue", "tenue", "renvoyee", "annulee"]).default("prevue").notNull(),
    renvoiReason: text("renvoi_reason"),
    // Added by W3-SCHEMA: a continuance (renvoyee) and a cancellation (annulee) are different events
    // and were conflated onto renvoiReason by a Wave 2 caller. Distinct, nullable column so a
    // cancellation records its own reason without borrowing the continuance field.
    cancelReason: text("cancel_reason"),
    renvoiOfId: bigint("renvoi_of_id", { mode: "number" }), // self-FK: citadel_case_hearings.id
    judgeLicense: varchar("judge_license", { length: 60 }),
    judgeName: varchar("judge_name", { length: 120 }),
    createdByLicense: varchar("created_by_license", { length: 60 }).notNull(),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    uniqueIndex("uq_case_hearing_ref").on(t.publicRef),
    index("idx_case_hearing_case").on(t.caseId, t.scheduledAt),
    index("idx_case_hearing_status").on(t.status),
  ],
);

/**
 * The judge's ruling on one party. `appealDeadlineAt` is `renderedAt` + the 72h window from
 * footnote `**` (citadel_penal_footnotes) - computed server-side at write time from that row, never
 * hardcoded in application code. `casierEntryId` points at the `jugement` casier entry this judgment
 * wrote.
 */
export const citadelCaseJudgments = mysqlTable(
  CT.caseJudgments,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull(), // FK citadel_justice_cases.id
    partyId: bigint("party_id", { mode: "number" }).notNull(), // FK citadel_case_parties.id
    hearingId: bigint("hearing_id", { mode: "number" }), // FK citadel_case_hearings.id
    verdict: mysqlEnum("verdict", ["coupable", "relaxe", "non_lieu", "contumace"]).notNull(),
    peinePrincipale: text("peine_principale"),
    amende: decimal("amende", { precision: 12, scale: 2, mode: "number" }).default(0).notNull(),
    custodyMinutes: int("custody_minutes").default(0).notNull(),
    custodyFacility: mysqlEnum("custody_facility", ["none", "saisie", "gav", "bolingbroke"]),
    peinesComplementaires: json("peines_complementaires"), // [{code, libelle, duration}]
    motivation: text("motivation"),
    judgeLicense: varchar("judge_license", { length: 60 }).notNull(),
    judgeName: varchar("judge_name", { length: 120 }).notNull(),
    renderedAt: createdNow("rendered_at"),
    casierEntryId: bigint("casier_entry_id", { mode: "number" }), // FK citadel_casier_entries.id
    appealDeadlineAt: datetime("appeal_deadline_at", { mode: "date" }).notNull(),
  },
  (t) => [
    index("idx_case_judgment_case").on(t.caseId),
    index("idx_case_judgment_party").on(t.partyId),
    index("idx_case_judgment_hearing").on(t.hearingId),
  ],
);

/** An appeal against a judgment. Footnote `**` is enforced at the data layer, not here: reject if
 * `filedAt > appealDeadlineAt`, and reject if `ruledByLicense` equals the original judgment's
 * `judgeLicense` (a judge cannot rule on their own decision). */
export const citadelCaseAppeals = mysqlTable(
  CT.caseAppeals,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    judgmentId: bigint("judgment_id", { mode: "number" }).notNull(), // FK citadel_case_judgments.id
    filedByLicense: varchar("filed_by_license", { length: 60 }).notNull(),
    filedAt: createdNow("filed_at"),
    motif: text("motif"),
    newEvidence: text("new_evidence"),
    status: mysqlEnum("status", ["deposee", "recevable", "irrecevable", "jugee"])
      .default("deposee")
      .notNull(),
    ruledByLicense: varchar("ruled_by_license", { length: 60 }),
    ruledAt: nullableDate("ruled_at"),
    ruling: text("ruling"),
  },
  (t) => [index("idx_case_appeal_judgment").on(t.judgmentId)],
);

/**
 * A raised "vice de procedure". When `status='retenu'` and the linked consequence's `effect` is
 * `revoke_entry`, the linked casier entry transitions to `visibility='revoked'` in the SAME
 * transaction, with `revokeDefectId` set - the wiring that makes the vice de procedure sheet a
 * mechanic rather than a document. Either `caseId` or `casierEntryId` is set, not necessarily both.
 */
export const citadelCaseDefects = mysqlTable(
  CT.caseDefects,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("case_id", { mode: "number" }), // FK citadel_justice_cases.id, nullable
    casierEntryId: bigint("casier_entry_id", { mode: "number" }), // FK citadel_casier_entries.id, nullable
    defectId: bigint("defect_id", { mode: "number" }).notNull(), // FK citadel_procedure_defects.id
    consequenceId: bigint("consequence_id", { mode: "number" }).notNull(), // FK citadel_procedure_consequences.id
    raisedByLicense: varchar("raised_by_license", { length: 60 }).notNull(),
    raisedAt: createdNow("raised_at"),
    argument: text("argument"),
    status: mysqlEnum("status", ["souleve", "retenu", "rejete"]).default("souleve").notNull(),
    ruledByLicense: varchar("ruled_by_license", { length: 60 }),
    ruledAt: nullableDate("ruled_at"),
    ruling: text("ruling"),
    // Added by W3-SCHEMA (JUSTICE_CAD_BUILD_SPEC.md §2.3 gap). `raisedAt` above already carries this
    // row's creation moment, but callers were routing through the incident event log purely to get a
    // field literally named created_at - added here for that same schema-wide convention.
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_case_defect_case").on(t.caseId),
    index("idx_case_defect_casier_entry").on(t.casierEntryId),
  ],
);

/**
 * The effacement petition. Owner decision: judge petition only, no automatic prescription sweeper
 * (JUSTICE_CAD_BUILD_SPEC.md §8). `casierEntryId` null = petition over the whole record. Granting
 * revokes the targeted entries and writes ONE `effacement` casier entry (`resultingEntryId`) recording
 * it - nothing is ever hard-deleted by this path.
 */
export const citadelCaseExpungements = mysqlTable(
  CT.caseExpungements,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(), // prefix "EF-" (§2.4)
    personIdentifier: varchar("person_identifier", { length: 60 }).notNull(),
    casierEntryId: bigint("casier_entry_id", { mode: "number" }), // FK citadel_casier_entries.id, nullable
    petitionedByLicense: varchar("petitioned_by_license", { length: 60 }).notNull(),
    petitionedAt: createdNow("petitioned_at"),
    motif: text("motif"),
    status: mysqlEnum("status", ["deposee", "accordee", "refusee"]).default("deposee").notNull(),
    ruledByLicense: varchar("ruled_by_license", { length: 60 }),
    ruledByName: varchar("ruled_by_name", { length: 120 }),
    ruledAt: nullableDate("ruled_at"),
    ruling: text("ruling"),
    resultingEntryId: bigint("resulting_entry_id", { mode: "number" }), // FK citadel_casier_entries.id
  },
  (t) => [
    uniqueIndex("uq_case_expungement_ref").on(t.publicRef),
    index("idx_case_expungement_person").on(t.personIdentifier),
    index("idx_case_expungement_casier_entry").on(t.casierEntryId),
  ],
);

/**
 * A frozen account (player or business). Built now per JUSTICE_CAD_BUILD_SPEC.md §7: the actual
 * gs_bank enforcement call is a single named function in the data layer that currently records the
 * freeze and returns - wired to the bank export when gs_bank Phase 2 lands. Do not fake enforcement.
 */
export const citadelAccountFreezes = mysqlTable(
  CT.accountFreezes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(), // prefix "GL-" (§2.4)
    subjectType: mysqlEnum("subject_type", ["player", "business"]).notNull(),
    subjectRef: varchar("subject_ref", { length: 60 }).notNull(),
    caseId: bigint("case_id", { mode: "number" }), // FK citadel_justice_cases.id, nullable
    frozenByLicense: varchar("frozen_by_license", { length: 60 }).notNull(),
    frozenByName: varchar("frozen_by_name", { length: 120 }).notNull(),
    frozenAt: createdNow("frozen_at"),
    frozenReason: text("frozen_reason"),
    releasedByLicense: varchar("released_by_license", { length: 60 }),
    releasedAt: nullableDate("released_at"),
    releaseReason: text("release_reason"),
    status: mysqlEnum("status", ["active", "released"]).default("active").notNull(),
  },
  (t) => [
    uniqueIndex("uq_account_freeze_ref").on(t.publicRef),
    index("idx_account_freeze_subject").on(t.subjectType, t.subjectRef, t.status),
    index("idx_account_freeze_case").on(t.caseId),
  ],
);

/**
 * CONVOCATIONS - a summons issued to a PERSON by the Bureau du Procureur or the DOJ (owner
 * 2026-08-22: "allow proc to do convocation too ... a person and a date and a place (place they
 * right themselves)").
 *
 * ⚠ NOT A `citadel_case_hearings` ROW, and the difference is structural, not stylistic. A hearing is
 * case-bound (`case_id` NOT NULL), sits in a `courtroom`, and names no person at all - the parties
 * come from the dossier. A convocation names a LICENCE, a date, and a free-text PLACE the issuer
 * types in, and is routinely issued with no dossier open yet, which is the whole point of the step:
 * `citadel_penal_procedure`'s `convocation` step exists to bring someone in BEFORE there is anything
 * to schedule. Folding it onto the hearings table would have made `case_id` nullable there and left
 * every hearing query having to exclude a row shape it was never written for.
 *
 * `agency` is WHO CONVOKED, stored rather than derived, because the Discord notice tells the player
 * which office to contact and that sentence must keep saying the same thing in a year when the
 * issuer has changed jobs. Same reasoning as `subject_name` / `issued_by_name`: both are SNAPSHOTS
 * taken at issue time, so a later rename never rewrites what the notice said.
 *
 * The status ladder is deliberately small: `prevue` -> `honoree` (they came) | `absente` (they did
 * not) | `annulee` (called off). `absente` is the one the penal warning points at - it is the state
 * from which a mandat de recherche is justified - but this table NEVER issues that warrant itself.
 * Creating a warrant stays the Mandats desk's job, gated on `warrant.approve`, so the threat in the
 * notice cannot become an automatic sanction nobody signed.
 */
export const citadelJusticeConvocations = mysqlTable(
  CT.justiceConvocations,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(), // prefix "CV-"
    /** The CAD agency that issued it: 'doj' or 'da'. Mirrors lib/cad/agencies.ts ids. */
    agency: varchar("agency", { length: 32 }).notNull(),
    /** Bare-hex `users.identifier` of the person summoned. */
    subjectIdentifier: varchar("subject_identifier", { length: 60 }).notNull(),
    /** RP name AT ISSUE TIME. A snapshot, so the record still reads correctly after a rename. */
    subjectName: varchar("subject_name", { length: 120 }).notNull(),
    scheduledAt: datetime("scheduled_at", { mode: "date" }).notNull(),
    /** Free text, written by the issuer. There is no place catalog and inventing one would force a
     *  judge to pick from a list that cannot describe where they actually want the person. */
    place: varchar("place", { length: 160 }).notNull(),
    motif: text("motif"),
    caseId: bigint("case_id", { mode: "number" }), // FK citadel_justice_cases.id, nullable on purpose
    /**
     * ⚠ `brouillon` EST LE SEUL ETAT OU RIEN N'A ETE ENVOYE, et c'est pour cela qu'il est en tete de
     * l'enum plutot qu'ajoute a la fin: l'ordre de l'enum est l'ordre de la vie de la ligne.
     * Demande proprietaire 2026-08-24 ("also allow to save as draft"). Un brouillon est une
     * convocation entierement redigee qui n'a produit AUCUN avis Discord: pas de ligne dans
     * citadel_justice_convocation_notices, pas de job, personne de prevenu. C'est aussi pour cela
     * qu'il ne compte jamais dans les convocations "en cours" ni dans le compteur des retards -
     * personne ne doit une reponse sur un rendez-vous que le convoque ignore.
     */
    status: mysqlEnum("status", ["brouillon", "prevue", "honoree", "absente", "annulee"]).default("prevue").notNull(),
    issuedByLicense: varchar("issued_by_license", { length: 60 }).notNull(),
    issuedByName: varchar("issued_by_name", { length: 120 }).notNull(),
    issuedAt: createdNow("issued_at"),
    /** Who moved it off `prevue`, and why. `closed_reason` is REQUIRED for `annulee` by the data
     *  layer (a cancellation the person is told about must say something), optional otherwise. */
    closedByLicense: varchar("closed_by_license", { length: 60 }),
    closedByName: varchar("closed_by_name", { length: 120 }),
    closedAt: nullableDate("closed_at"),
    closeReason: text("close_reason"),
  },
  (t) => [
    uniqueIndex("uq_justice_convocation_ref").on(t.publicRef),
    index("idx_justice_convocation_subject").on(t.subjectIdentifier, t.scheduledAt),
    index("idx_justice_convocation_status").on(t.status, t.scheduledAt),
    index("idx_justice_convocation_agency").on(t.agency),
  ],
);

/**
 * THE DELIVERY LEDGER for the Discord notices a convocation sends. One row per attempt to tell one
 * person one thing.
 *
 * ⚠ WHY THIS IS NOT FOUR `notify_*` COLUMNS ON THE CONVOCATION. A convocation sends MORE THAN ONE
 * notice over its life: the summons itself, a cancellation notice if it is called off, and a manual
 * resend when the first one bounced. Scalar columns would let the cancellation's outcome overwrite
 * the summons's, which destroys the single fact anyone will ever need to look up - "was this person
 * actually told, and when". This is the exact shape and the exact reasoning as
 * `citadel_ticket_deliveries` (see its own note); the 2026-07-17 split there happened for the same
 * reason and must not be undone here either.
 *
 * `discord_id` is resolved AT ENQUEUE TIME (lib/data/convocations.ts, through
 * lib/data/discordPrimary.ts - never a bare `LIMIT 1` on citadel_identifiers, see that file) and
 * stored, so the ledger records who was actually written to rather than who we would resolve today.
 * A person with no linked Discord produces a row with `status = 'no_discord'` and NO citadel_jobs
 * row at all: there is nothing to send, and a queued job that can never succeed would burn its five
 * attempts and die as if Discord had failed.
 */
export const citadelJusticeConvocationNotices = mysqlTable(
  CT.justiceConvocationNotices,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    convocationId: bigint("convocation_id", { mode: "number" }).notNull(),
    /** WHICH message this row is. Drives the copy the bot builds and the embed colour it uses. */
    kind: mysqlEnum("kind", ["convocation", "annulation"]).notNull(),
    /** Snowflake we resolved for the subject, or null when they have no linked Discord. */
    discordId: varchar("discord_id", { length: 32 }),
    status: mysqlEnum("status", ["pending", "sent", "failed", "no_discord"]).default("pending").notNull(),
    /** Discord's own message id, kept for the same reason citadel_ticket_deliveries keeps it: it is
     *  the only durable proof the DM exists on their side. */
    discordMessageId: varchar("discord_message_id", { length: 32 }),
    error: varchar("error", { length: 255 }),
    /** citadel_jobs.id of the discord.convocationDm row, so the desk can point at a stuck job. */
    jobId: bigint("job_id", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [
    index("idx_convocation_notice_convocation").on(t.convocationId, t.id),
    index("idx_convocation_notice_status").on(t.status),
  ],
);

/** Same shape as citadel_casier_attachments, sidecar for citadel_account_freezes. Renders nothing
 * until R2 lands (JUSTICE_CAD_BUILD_SPEC.md §7). */
export const citadelFreezeAttachments = mysqlTable(
  CT.freezeAttachments,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    freezeId: bigint("freeze_id", { mode: "number" }).notNull(), // FK citadel_account_freezes.id
    uploadId: bigint("upload_id", { mode: "number" }).notNull(), // FK citadel_uploads.id
    caption: varchar("caption", { length: 200 }),
    addedByLicense: varchar("added_by_license", { length: 60 }).notNull(),
    addedAt: createdNow("added_at"),
  },
  (t) => [index("idx_freeze_attachment_freeze").on(t.freezeId)],
);

/**
 * Free-text notes on a person's justice profile (JUSTICE_CAD_BUILD_SPEC.md §5.2 person profile - the
 * spec calls for free-text notes and no table ever existed for them). Append-only, soft-delete only:
 * `authorLicense`/`authorName`/`authorAgency` are denormalized on purpose, same convention as
 * citadel_casier_entries' author block, so "who wrote this" still renders correctly after the author
 * has left the faction or the character is gone.
 */
export const citadelPersonNotes = mysqlTable(
  CT.personNotes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    personIdentifier: varchar("person_identifier", { length: 60 }).notNull(), // bare hex, joins users.identifier
    body: text("body").notNull(),
    authorLicense: varchar("author_license", { length: 60 }).notNull(),
    authorName: varchar("author_name", { length: 80 }).notNull(),
    authorAgency: varchar("author_agency", { length: 16 }).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
    deletedAt: nullableDate("deleted_at"),
  },
  (t) => [index("idx_person_note_person").on(t.personIdentifier, t.deletedAt)],
);

/**
 * Opaque deep-link refs for the two identifying values that must NEVER appear in a URL: a bare-hex
 * license (`person`) or a plate (`vehicle`). JUSTICE_CAD_BUILD_SPEC.md §4.1 (owner, 2026-07-26): a
 * shared link must resolve to the SAME target every time (`uq_cad_ref_target` - mint-or-reuse, never
 * a fresh ref per request), and the ref itself must be meaningless outside this panel.
 *
 * Case/hearing/freeze deep links reuse each object's OWN existing `public_ref` column
 * (`citadel_cad_incidents`, `citadel_case_hearings`, `citadel_account_freezes`) - this table exists
 * ONLY for person/vehicle, which had no opaque handle at all before this. `target` is the real
 * license/plate; resolving a ref is a DB lookup, never a client-side decode, and the value never
 * leaves the server for this purpose (lib/data/cadRefs.ts).
 */
export const citadelCadRefs = mysqlTable(
  CT.cadRefs,
  {
    ref: varchar("ref", { length: 16 }).primaryKey(), // 'PR-A3F9' / 'VH-B7K2'
    kind: mysqlEnum("kind", ["person", "vehicle"]).notNull(),
    target: varchar("target", { length: 60 }).notNull(), // bare-hex license, or plate
    createdAt: createdNow("created_at"),
  },
  (t) => [uniqueIndex("uq_cad_ref_target").on(t.kind, t.target)],
);

/**
 * Portrait/mugshot photos (2026-07-26). One table, two consumers, split by `slot`:
 *   - Player page identity photos: slot in ('front','left','right','back'). Exactly one ACTIVE row
 *     per (personIdentifier, slot) at a time - uploading a new one flips the previous row's
 *     `active` to false rather than deleting it, so "show old ones" on an update is a plain query,
 *     not a separate history table.
 *   - CAD casier mugshot strip: slot = 'booking'. Never superseded - every upload is its own
 *     permanent row (a booking log), ordered by `createdAt`.
 * `source` distinguishes an uploaded file (uploadId FK, row stays invisible until the linked
 * citadel_uploads row is 'active' - i.e. until R2 is configured and the confirm step runs) from a
 * pasted URL (linkUrl, immediately usable, no storage dependency at all - same "Depuis internet"
 * escape hatch the reference UI offers). Soft-delete only, same discipline as citadel_person_notes.
 */
export const citadelIdentityPhotos = mysqlTable(
  CT.identityPhotos,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    personIdentifier: varchar("person_identifier", { length: 60 }).notNull(), // bare hex, joins users.identifier
    slot: mysqlEnum("slot", ["front", "left", "right", "back", "booking"]).notNull(),
    source: mysqlEnum("source", ["upload", "link"]).notNull(),
    uploadId: bigint("upload_id", { mode: "number" }), // FK citadel_uploads.id, set when source='upload'
    linkUrl: varchar("link_url", { length: 500 }), // set when source='link'
    active: boolean("active").default(true).notNull(),
    authorLicense: varchar("author_license", { length: 60 }).notNull(),
    authorName: varchar("author_name", { length: 80 }).notNull(),
    authorAgency: varchar("author_agency", { length: 16 }),
    createdAt: createdNow("created_at"),
    deletedAt: nullableDate("deleted_at"),
  },
  (t) => [
    index("idx_identity_photo_person").on(t.personIdentifier, t.slot, t.active, t.deletedAt),
    index("idx_identity_photo_upload").on(t.uploadId),
  ],
);

/* ── Forensic watermark ──────────────────────────────────────────────────────
 * One row per staff session that has been served a watermark tile. The rendered pattern encodes
 * ONLY `mark_id`, which is opaque; everything that turns a recovered mark into an accusation
 * (which account, which session, from which IP, when) lives here, server-side.
 *
 * Design: _server_build/CITADEL_LEAK_TRACING.md §3.
 *
 * ⚠ `pattern_version` is load-bearing. The pattern is a pure function of (mark_id, secret, tunables
 * in lib/watermark/config.ts). Retuning those tunables in place would make every mark issued before
 * the change undecodable. Bump PATTERN_VERSION instead and generate at the version the row records.
 */
export const citadelWatermarkMarks = mysqlTable(
  CT.watermarkMarks,
  {
    // Opaque, URL-safe, unguessable. This is what the tile encodes and what the detector returns.
    markId: varchar("mark_id", { length: 32 }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    // Auth.js session this mark belongs to, HASHED - a session token is a bearer credential and this
    // table is read by the leak-check surface. Storing the raw token would put live credentials in
    // front of anyone who can view a detection result.
    sessionHash: varchar("session_hash", { length: 64 }),
    patternVersion: int("pattern_version").default(1).notNull(),
    // Capture context, for the "when and from where" half of an investigation.
    ip: varchar("ip", { length: 45 }),
    userAgent: varchar("user_agent", { length: 255 }),
    issuedAt: createdNow("issued_at"),
    // Refreshed whenever the tile is re-fetched, so a mark's active window is visible.
    lastSeenAt: nullableDate("last_seen_at"),
    // Last integrity heartbeat from the overlay (P3). ⚠ Its ABSENCE is the real signal: a client
    // that reports nothing is exactly what a removed overlay looks like, so the sweeper cross-checks
    // this against staff.page.view audit rows, which come from a completely separate code path.
    heartbeatAt: nullableDate("heartbeat_at"),
    // Set the first time this mark's overlay was reported or inferred missing/tampered.
    tamperAt: nullableDate("tamper_at"),
    tamperReason: varchar("tamper_reason", { length: 64 }),
    // Set when the session ends or the mark is rotated. Retired marks stay FOREVER: a leak can
    // surface months later and the row is the only thing that can name it.
    retiredAt: nullableDate("retired_at"),
  },
  (t) => [
    index("idx_wm_account").on(t.accountId, t.issuedAt),
    index("idx_wm_session").on(t.sessionHash),
    index("idx_wm_issued").on(t.issuedAt),
    index("idx_wm_heartbeat").on(t.accountId, t.heartbeatAt),
  ],
);

/**
 * Every image the leak sweep has examined. Design: _server_build/CITADEL_LEAK_TRACING.md §4.1.
 *
 * ⚠ MISSES ARE RECORDED ON PURPOSE, and that is the main reason this table exists. A sweep that has
 * quietly stopped receiving attachments (the MessageContent privileged intent was revoked, the bot
 * lost read access to a channel, the process died) produces exactly the same observable as a sweep
 * that is running and finding nothing: silence. Counting what was actually looked at is the only
 * thing that separates "no leaks" from "not watching".
 *
 * `attachment_id` is UNIQUE, so a reposted image is recorded once and never re-analysed.
 */
export const citadelLeakScans = mysqlTable(
  CT.leakScans,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    source: mysqlEnum("source", ["discord", "manual"]).notNull(),
    guildId: varchar("guild_id", { length: 32 }),
    channelId: varchar("channel_id", { length: 32 }),
    messageId: varchar("message_id", { length: 32 }),
    // Discord's attachment snowflake. Unique: the dedupe key.
    attachmentId: varchar("attachment_id", { length: 40 }),
    attachmentName: varchar("attachment_name", { length: 255 }),
    // WHO POSTED IT, which is a different question from whose watermark is in it. A leaker often
    // is not the poster (the image gets forwarded), so conflating the two would accuse the wrong
    // person; both are kept and the panel shows them separately.
    authorDiscordId: varchar("author_discord_id", { length: 32 }),
    width: int("width"),
    height: int("height"),
    bytes: int("bytes"),
    verdict: mysqlEnum("verdict", ["accuse", "lead", "none", "error"]).notNull(),
    topMarkId: varchar("top_mark_id", { length: 32 }),
    topAccountId: bigint("top_account_id", { mode: "number" }),
    topZ: float("top_z"),
    candidates: int("candidates"),
    elapsedMs: int("elapsed_ms"),
    error: varchar("error", { length: 255 }),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    uniqueIndex("uq_leak_scan_attachment").on(t.attachmentId),
    index("idx_leak_scan_verdict").on(t.verdict, t.createdAt),
    index("idx_leak_scan_created").on(t.createdAt),
    index("idx_leak_scan_account").on(t.topAccountId),
  ],
);

/* ── Discord invite tracking ─────────────────────────────────────────────────
 * Owner request 2026-07-31: "i want to know who invited who".
 *
 * ⚠ THE MECHANISM IS A DIFF, NOT AN EVENT. Discord does NOT tell you which invite a member used.
 * The only way to know is to hold a snapshot of every invite's `uses` count, and when someone joins,
 * re-fetch and find the code whose counter went up. Everything awkward about these tables follows
 * from that: the mirror must be kept current or attribution silently degrades to "unknown", and
 * concurrent joins can be genuinely ambiguous.
 */
export const citadelDiscordInvites = mysqlTable(
  CT.discordInvites,
  {
    // Discord invite codes are globally unique, so the code alone is the key.
    code: varchar("code", { length: 32 }).primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }),
    inviterDiscordId: varchar("inviter_discord_id", { length: 32 }),
    uses: int("uses").default(0).notNull(),
    maxUses: int("max_uses").default(0).notNull(),
    expiresAt: nullableDate("expires_at"),
    firstSeenAt: createdNow("first_seen_at"),
    lastSeenAt: nullableDate("last_seen_at"),
    // Set when the code stops coming back from Discord (revoked, expired, or hit max uses).
    // ⚠ NEVER hard-deleted: the attribution ledger references codes that no longer exist, and a
    // deleted row would turn a historical answer into a dangling reference.
    deletedAt: nullableDate("deleted_at"),
  },
  (t) => [
    index("idx_dinv_guild").on(t.guildId, t.deletedAt),
    index("idx_dinv_inviter").on(t.inviterDiscordId),
  ],
);

export const inviteJoinMethods = ["invite", "vanity", "unknown", "ambiguous", "bot_or_oauth"] as const;

export const citadelDiscordInviteJoins = mysqlTable(
  CT.discordInviteJoins,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    memberDiscordId: varchar("member_discord_id", { length: 32 }).notNull(),
    memberTag: varchar("member_tag", { length: 64 }),
    inviteCode: varchar("invite_code", { length: 32 }),
    inviterDiscordId: varchar("inviter_discord_id", { length: 32 }),
    inviterTag: varchar("inviter_tag", { length: 64 }),
    /**
     * How confident the attribution is, and it must be read before trusting `inviterDiscordId`:
     *   invite       - exactly one code's counter moved. Trustworthy.
     *   vanity       - the guild's vanity URL. No inviter exists by definition.
     *   ambiguous    - several counters moved between snapshots (concurrent joins). The code stored
     *                  is a GUESS and the inviter must not be presented as fact.
     *   unknown      - no counter moved: cold cache after a bot restart, or the bot lacks Manage
     *                  Guild so it cannot read invites at all.
     *   bot_or_oauth - a bot, or a member added via the guilds.join scope. No invite involved.
     */
    method: mysqlEnum("method", inviteJoinMethods).notNull(),
    /** Account age at join. A minutes-old account arriving on someone's invite is worth seeing. */
    accountCreatedAt: nullableDate("account_created_at"),
    joinedAt: createdNow("joined_at"),
    // Set if they later leave, so the ledger shows retention per inviter rather than just arrivals.
    leftAt: nullableDate("left_at"),
  },
  (t) => [
    index("idx_dij_guild_joined").on(t.guildId, t.joinedAt),
    index("idx_dij_inviter").on(t.inviterDiscordId, t.joinedAt),
    index("idx_dij_member").on(t.memberDiscordId),
  ],
);

/**
 * Guild memberships from the `guilds` OAuth scope (owner request 2026-07-31).
 *
 * ⚠ REPLACED WHOLESALE ON EVERY LOGIN, never diffed. Discord returns the complete list, and treating
 * a missing entry as "they left that guild" would be wrong: it is equally "they logged in from an
 * account that had the scope revoked" or "the API call failed". A snapshot is honest; an inferred
 * event is not.
 */
export const citadelDiscordUserGuilds = mysqlTable(
  CT.discordUserGuilds,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    guildName: varchar("guild_name", { length: 120 }),
    icon: varchar("icon", { length: 64 }),
    owner: boolean("owner").default(false).notNull(),
    /** Their permission bitfield in that guild, as a string (it exceeds 2^53). */
    permissions: varchar("permissions", { length: 32 }),
    capturedAt: createdNow("captured_at"),
  },
  (t) => [
    uniqueIndex("uq_dug_user_guild").on(t.discordId, t.guildId),
    index("idx_dug_guild").on(t.guildId),
  ],
);

/**
 * Per-staff verdicts on /staff/reference's static implementation catalogue (2026-08-05).
 *
 * ONE ROW PER (staff, entry) - resubmitting updates the same row rather than piling up a history,
 * same convention as citadel_ticket_reads: the page needs "does THIS person say this works right
 * now", not a change log. `authorName` is denormalized at write time (same convention as
 * citadel_ban_appeals/citadel_player_notes' authorName) so an old report still shows who wrote it
 * after a display-name change, without a join.
 *
 * `entrySlug` is NOT a foreign key - the catalogue it points at lives in
 * lib/data/implementationCatalog.ts (a text file), not a table. Renaming a "### " heading there
 * changes its slug and orphans any report keyed on the old one; lib/data/catalogTestReports.ts
 * handles that by simply not matching the row to any entry any more, not by erroring.
 */
export const citadelCatalogTestReports = mysqlTable(
  CT.catalogTestReports,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entrySlug: varchar("entry_slug", { length: 160 }).notNull(),
    /** "legal" | "illegal" - denormalized from the catalogue so a stale/renamed entry still shows
     *  which half of the page it came from even if its slug no longer resolves. */
    category: mysqlEnum("category", ["legal", "illegal"]).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    authorName: varchar("author_name", { length: 80 }).notNull(),
    verdict: mysqlEnum("verdict", ["works", "broken", "partial"]).notNull(),
    /** Issues found / suggestions. Free text, staff-authored - not moderation content, so unlike
     *  most CITADEL writes this is intentionally NOT run through citadel_audit (see actions.ts). */
    notes: text("notes"),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained; refreshed on every resubmit
  },
  (t) => [
    uniqueIndex("uq_catalog_test_reports_account_entry").on(t.accountId, t.entrySlug),
    index("idx_catalog_test_reports_entry").on(t.entrySlug),
  ],
);

/* ── LifeInvader Entreprises · le portail des commerces joueurs ──────────────────────────────────
 *
 * Maquette validée: citadel/design/business-portal-demo.html.
 *
 * CE QUE CE MODULE ENREGISTRE, ET CE QU'IL N'ENREGISTRE PAS. La vente se joue EN RP: un employé
 * sert un client, établit une facture en jeu, le client paie. Le serveur n'a aucun moyen de savoir
 * ce qui s'est passé dans la scène, et surtout pas si le client a payé en liquide. Le portail
 * enregistre donc une DÉCLARATION, pas une mesure. Tout ce qui prétendrait mesurer la vente
 * elle-même serait inventé, et c'est exactement pour ça que les états "encaissée" et "en attente"
 * ont été retirés de la maquette: seul l'ÉCART entre le montant déclaré et le versement reçu par la
 * société se constate réellement.
 */

/**
 * Le commerce. Une ligne = un métier qui a le portail ACTIVÉ.
 *
 * ⚠ L'activation est une décision explicite. Il y a ~130 métiers dans `jobs`; un métier absent
 * d'ici n'a pas de portail, plutôt que l'inverse. Sinon chaque métier ajouté au jeu ouvrirait
 * silencieusement une boutique au catalogue vide.
 *
 * `job` est le nom de métier ESX (jobs.name), la seule clé que le jeu et le panel partagent.
 * `slug` est l'URL (/business/<slug>/...), stocké et non calculé: renommer l'enseigne ne doit pas
 * casser les liens déjà partagés, donc les deux évoluent séparément.
 */
export const citadelBusinesses = mysqlTable(
  CT.businesses,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    job: varchar("job", { length: 60 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    /** Nom d'enseigne affiché. Peut différer de jobs.label: "24/7 Strawberry" plutôt que "247". */
    name: varchar("name", { length: 120 }).notNull(),
    /** Modèle d'entreprise (bar / garage / commerce). Porte les modules par défaut. */
    template: varchar("template", { length: 32 }).default("commerce").notNull(),
    /**
     * UNIQUEMENT les différences avec le modèle, jamais l'état complet des modules.
     * Stocker l'état complet ferait qu'un changement de modèle ne se propage à personne: chaque
     * commerce aurait figé une copie le jour de sa création. Ici, changer le modèle "bar" met à
     * jour les onze bars, et seuls les modules explicitement personnalisés résistent.
     */
    moduleOverrides: parsedJson<Record<string, boolean>>()("module_overrides"),
    /** Palette de l'enseigne (marque, 4 catégories, plaque produit). null = celle du modèle. */
    palette: parsedJson<{ dark: Record<string, string>; light: Record<string, string> }>()("palette"),
    /**
     * QUI A LE DROIT DE QUOI, par GRADE DE MÉTIER EN JEU: `{ "2": ["team.read", ...] }`.
     *
     * ⚠ EN JSON ET NON EN TABLE, et c'est un choix, pas un raccourci. Ces droits ne sont jamais
     * interrogés en travers des commerces, jamais filtrés, jamais triés: ils sont lus EN ENTIER avec
     * le commerce et réécrits EN ENTIER depuis la page Réglages. Une table aurait produit exactement
     * la même lecture (tout prendre, construire une Map en mémoire) au prix d'une requête de plus sur
     * un résolveur qui tourne à chaque rendu ET à chaque mutation. Une relation se justifie par les
     * requêtes qu'elle permet; celles-là n'existaient pas.
     *
     * ⚠⚠ LE GRADE PATRON N'APPARAÎT JAMAIS ICI. Il détient tout, implicitement, et cela ne se
     * révoque pas: la ligne "le patron perd le catalogue" doit être impossible à ÉCRIRE, sinon une
     * fausse manoeuvre enferme une entreprise dehors sans personne à l'intérieur pour rouvrir la
     * porte. Même raisonnement que le '*' du Fondateur côté staff.
     *
     * `null` (jamais configuré) et `{}` (tout retiré à tout le monde) sont DEUX états distincts:
     * le premier déclenche le repli jour-un, le second est une décision qu'on respecte.
     */
    grants: parsedJson<Record<string, string[]>>()("grants"),
    /**
     * LES RAYONS DU CATALOGUE: `[{ key, label, tone, icon }]`, dans l'ordre d'affichage.
     *
     * En JSON pour la même raison que `grants`, plus une qui leur est propre: un article désigne son
     * rayon PAR SON NOM (`items.category`), donc les rayons appartiennent au commerce et à personne
     * d'autre. `tone` est un numéro de 1 à 4 qui désigne une entrée de la palette, jamais une couleur
     * écrite en dur: la couleur appartient à l'enseigne, la position appartient au rayon.
     */
    categories: parsedJson<{ key: string; label: string; tone: number; icon?: string }[]>()("categories"),
    /**
     * LA PART EMPLOYÉ, POLITIQUE DU COMMERCE: `{ mode, bps, byEmployee }`. Voir lib/business/commission.ts.
     *
     * ⚠ EN JSON, même raisonnement exact que `grants` juste au-dessus: cette politique est lue EN
     * ENTIER avec le commerce, à chaque rendu comme à chaque mutation, et réécrite EN ENTIER depuis
     * un seul écran. Elle n'est jamais interrogée en travers des commerces, ni triée, ni filtrée. Une
     * table `commission_rates(business_id, identifier, bps)` aurait produit la même lecture (tout
     * prendre, faire une Map) au prix d'une requête de plus sur le résolveur le plus chaud du portail.
     *
     * ⚠ `null` VEUT DIRE "JAMAIS RÉGLÉ" ET DÉCLENCHE LE REPLI SUR LE MODÈLE, ce qui n'est pas la
     * même chose qu'un mode `montant` à 0 écrit explicitement. Un salon de tatouage tout neuf hérite
     * donc des 50 % de son modèle; un commerce qui a délibérément tout remis à zéro garde son zéro.
     *
     * ⚠ LES TAUX PAR PERSONNE SONT UNE DÉCISION DE PAIE, PAS UN CACHE. Ils survivent au départ de
     * l'employé dans la colonne, mais `sanitizeCommission` les purge à la première réécriture contre
     * l'effectif réel: une réembauche ne doit pas reprendre en silence un accord d'il y a six mois.
     */
    commission: parsedJson<{
      mode: "montant" | "pourcentage";
      bps: number;
      byEmployee: Record<string, number>;
      vehicleProfitBps?: number;
      byGrade?: Record<string, number>;
    }>()("commission"),
    /**
     * LE PLAFOND D'UNE LIGNE SAISIE À LA MAIN, en centimes. N'a de sens que pour un commerce dont le
     * modèle déclare une grille de caisse (voir `BusinessGrid`), où l'EMPLOYÉ tape le prix.
     *
     * ⚠⚠ CE N'EST PAS UN CONFORT D'INTERFACE, C'EST LE SEUL GARDE-FOU DE CE MODE. Partout ailleurs
     * le prix vient de la base et le navigateur n'envoie que des identifiants; ici il envoie un
     * montant, et la part employé est un POURCENTAGE de ce montant. Sans plafond, "je tape mon prix"
     * est exactement "je tape ma paie", et l'employeur découvre la facture en fin de semaine.
     *
     * ⚠ `null` = jamais réglé, donc repli sur le plafond de départ du modèle. Un `null` n'a jamais
     * voulu dire "aucune limite": `declareFreeSale` refuse de vendre s'il ne peut pas résoudre un
     * plafond, plutôt que d'en déduire l'infini.
     */
    freeLineMaxCents: int("free_line_max_cents"),
    active: boolean("active").default(true).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_businesses_job").on(t.job),
    uniqueIndex("uq_businesses_slug").on(t.slug),
  ],
);

/**
 * Le catalogue vendable, tenu par la direction du commerce.
 *
 * Les montants sont des ENTIERS DE CENTIMES, jamais des flottants. L'argent en virgule flottante
 * finit toujours par produire un total faux d'un centime, et ce module existe précisément pour
 * comparer un total déclaré à un versement société.
 *
 * ⚠ commissionCents est ce que touche l'EMPLOYÉ et ne sort JAMAIS de la facture du client. Le
 * client paie priceCents; la société verse la part en fin de semaine. La traiter comme une remise
 * inverserait le sens: l'argent sortirait de la poche du client au lieu de celle du commerce.
 */
export const citadelBusinessItems = mysqlTable(
  CT.businessItems,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    businessId: bigint("business_id", { mode: "number" }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    category: varchar("category", { length: 60 }).notNull(),
    priceCents: int("price_cents").notNull(),
    commissionCents: int("commission_cents").default(0).notNull(),
    /** Visuel de l'article. null = repli sur l'icône de sa catégorie (la carte reste complète). */
    artKey: varchar("art_key", { length: 60 }),
    imageUrl: varchar("image_url", { length: 400 }),
    active: boolean("active").default(true).notNull(),
    sort: int("sort").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_business_items_business").on(t.businessId, t.active),
    index("idx_business_items_category").on(t.businessId, t.category),
  ],
);

/**
 * Une vente DÉCLARÉE: le ticket.
 *
 * `sellerIdentifier` est l'identifiant ESX en HEX NU (users.identifier), jamais "license:xxx":
 * c'est la forme qu'utilise tout le reste du schéma, et y écrire la forme préfixée corromprait
 * silencieusement chaque jointure.
 *
 * `sellerName` est une COPIE au moment de la déclaration. Le nom RP change (mariage, MortRP,
 * correction staff); un ticket doit continuer de dire qui l'a déclaré ce jour-là, pas qui porte ce
 * personnage aujourd'hui. Même raison que society_transactions.name côté jeu.
 *
 * `publicRef` est aléatoire et jamais dérivé de l'id: un compteur séquentiel dirait au client
 * combien de ventes le commerce a faites. Même règle que citadel_tickets.public_ref.
 */
export const citadelBusinessSales = mysqlTable(
  CT.businessSales,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    businessId: bigint("business_id", { mode: "number" }).notNull(),
    publicRef: varchar("public_ref", { length: 16 }).notNull(),
    /**
     * CLÉ D'IDEMPOTENCE, produite par le navigateur AVANT l'envoi et unique par commerce.
     *
     * Un double-clic, un renvoi automatique après une coupure réseau, ou un Server Action rejoué
     * produisent la même clé, donc l'index unique transforme le doublon en erreur au lieu d'un
     * second ticket. Dédupliquer autrement (même vendeur, même total, même minute) serait FAUX
     * ici: un bar sert légitimement deux fois la même tournée dans la minute, et on effacerait une
     * vente réelle. La clé vient du client parce que c'est le client qui sait que c'est le MÊME
     * geste; elle ne porte aucune autorité, elle ne fait que nommer une tentative.
     */
    clientRef: varchar("client_ref", { length: 40 }).notNull(),
    sellerIdentifier: varchar("seller_identifier", { length: 60 }).notNull(),
    sellerName: varchar("seller_name", { length: 120 }).notNull(),
    /** Somme des lignes, recalculée serveur. Jamais acceptée du client. */
    totalCents: int("total_cents").notNull(),
    /** Somme des parts employé. Hors facture client, par construction. */
    commissionCents: int("commission_cents").default(0).notNull(),
    /**
     * LE BÉNÉFICE MESURABLE DU TICKET: somme de `(prix - coût) x qté` sur les seules lignes qui
     * portent un coût de revient (`unit_cost_cents`). Ajouté le 2026-08-27.
     *
     * ⚠ COPIE FIGÉE COMME `total_cents` ET `commission_cents`, et pour la même raison: un prix de
     * catalogue qui bouge demain ne doit pas réécrire ce qu'une vente d'hier a rapporté. C'est aussi
     * ce qui permet à la page Équipe d'agréger une semaine par une simple somme de colonne au lieu
     * d'une jointure sur les lignes à chaque rendu.
     *
     * ⚠ ZÉRO VEUT DIRE "RIEN DE MESURABLE ICI", PAS "VENDU À PRIX COÛTANT". Une tournée de bar n'a
     * aucun coût de revient enregistré (`unit_cost_cents` reste NULL, voir la table des lignes), et
     * ses lignes contribuent donc 0. C'est pour ça que l'affichage du bénéfice est réservé aux
     * modèles qui facturent un coût connu (concession, garage): ailleurs, un "Bénéfice 0 $" se
     * lirait comme une perte alors que la donnée n'existe simplement pas.
     */
    marginCents: int("margin_cents").default(0).notNull(),
    /**
     * Déclarée après coup (oubli, fin de service). Le gérant doit pouvoir distinguer une
     * déclaration faite dans la foulée d'une déclaration rattrapée le lendemain, sans que ce soit
     * une accusation: c'est une information, pas une sanction.
     */
    backdated: boolean("backdated").default(false).notNull(),
    note: varchar("note", { length: 300 }),
    declaredAt: createdNow("declared_at"),

    /* ── LA FICHE CLIENT: à qui, et sur quelle voiture ──────────────────────────────────────────
     *
     * Demande du propriétaire (2026-08-21): une concession et un garage doivent porter *"the
     * firstname lastname birthdate and phone number of the person they sell to"*, *"the plate of the
     * car"*, *"all the customs and what car"*. Exigée par le MODÈLE du commerce
     * (`templateRequiresClientRecord`), jamais par le navigateur.
     *
     * ⚠⚠ TOUTES CES COLONNES SONT NULLABLES, ET ELLES DOIVENT LE RESTER. Onze bars, deux supérettes
     * et un salon de tatouage déclarent des ventes qui n'ont ni client identifié ni voiture, et des
     * milliers de tickets EXISTANTS n'ont jamais rien pu porter ici. Un `NOT NULL` obligerait à
     * inventer une valeur de remplissage sur de l'historique, c'est-à-dire à écrire un faux dans une
     * fiche que le patron lira comme un fait. L'obligation vit dans `declareSale`, où elle sait de
     * quel modèle de commerce il s'agit; la colonne, elle, se contente d'enregistrer.
     *
     * ⚠ LES LONGUEURS SUIVENT LES COLONNES DU JEU, PAS UN CHOIX D'ICI: 32 = `users.firstname`,
     * 10 = `users.dateofbirth` (`JJ/MM/AAAA`), 20 = `users.phone_number`, 12 = `owned_vehicles.plate`.
     * C'est ce qui permet à un gérant de comparer une fiche à une identité en jeu sans se demander
     * laquelle des deux a été tronquée.
     */
    clientFirstname: varchar("client_firstname", { length: 32 }),
    clientLastname: varchar("client_lastname", { length: 32 }),
    /** `JJ/MM/AAAA`, la forme exacte de `users.dateofbirth`. Voir lib/business/clientRecord.ts. */
    clientDob: varchar("client_dob", { length: 10 }),
    /** Chiffres uniquement, la forme exacte de `users.phone_number`. */
    clientPhone: varchar("client_phone", { length: 20 }),
    /** La plaque telle que l'employé l'a saisie, normalisée en majuscules. */
    vehiclePlate: varchar("vehicle_plate", { length: 12 }),
    /**
     * CE QUE LA BASE DE JEU SAVAIT DE CETTE PLAQUE, tri-état, et NULL quand le ticket n'a pas de
     * fiche du tout.
     *
     * ⚠ `absent` N'EST PAS UNE ERREUR ET SURTOUT PAS "AUCUNE OPTION": c'est le cas normal d'une
     * concession qui déclare avant la livraison. Le distinguer de `found` est ce qui empêche
     * l'écran d'affirmer qu'une voiture est d'origine alors qu'on ne l'a simplement jamais trouvée.
     * Même distinction, même raison, que `VehicleMods.record`.
     */
    vehicleRecord: mysqlEnum("vehicle_record", ["found", "absent", "unreadable"]),
    /** Le nom du modèle résolu à la déclaration ("Dubsta 6x6"). Copie datée, comme un libellé de ligne. */
    vehicleModel: varchar("vehicle_model", { length: 80 }),
    /** Le code de spawn ("dubsta3"), ce qu'un staff retranscrit dans une commande. */
    vehicleModelName: varchar("vehicle_model_name", { length: 60 }),
    /** La classe FR ("Off-Road"). */
    vehicleClass: varchar("vehicle_class", { length: 60 }),
    /** Le métier propriétaire si c'est un véhicule de flotte. Jamais l'identifiant d'un joueur. */
    vehicleFleetJob: varchar("vehicle_fleet_job", { length: 60 }),
    /**
     * LES CUSTOMS, EN MOTS, telles qu'elles étaient au moment de la déclaration (JSON `VehicleMods`).
     *
     * ⚠ LE DÉCODÉ ET NON LE BLOB BRUT, pour la raison qui fait qu'une ligne copie son prix: un ticket
     * est un fait daté. Redécoder demain avec un `esx_lscustom/config.lua` retouché réécrirait ce que
     * le client a lu sur sa facture. Voir lib/business/vehicleLookup.ts.
     */
    vehicleMods: text("vehicle_mods"),
  },
  (t) => [
    uniqueIndex("uq_business_sales_ref").on(t.publicRef),
    uniqueIndex("uq_business_sales_client_ref").on(t.businessId, t.clientRef),
    index("idx_business_sales_biz_date").on(t.businessId, t.declaredAt),
    index("idx_business_sales_seller").on(t.businessId, t.sellerIdentifier, t.declaredAt),
    /**
     * ⚠ INDEXÉ SUR LA PLAQUE, ET C'EST LA SEULE RAISON POUR LAQUELLE CETTE FICHE SERT À QUELQUE CHOSE.
     * La question que le patron pose n'est pas "montre-moi ce ticket" (il a déjà la référence), c'est
     * "qu'est-ce qui a été fait sur cette voiture, et par qui". Sans index, cette recherche est un
     * balayage complet des ventes du commerce, donc quelque chose qu'on finit par ne pas offrir.
     * Cloisonné par `business_id` en tête, comme toutes les lectures de ce module.
     */
    index("idx_business_sales_plate").on(t.businessId, t.vehiclePlate),
  ],
);

/**
 * Les lignes du ticket.
 *
 * ⚠ Chaque ligne COPIE le libellé, le prix et la part au moment de la vente, et `itemId` est
 * nullable. Un catalogue vit: un prix change, un article est retiré. Sans ces copies, augmenter le
 * prix d'un article réécrirait rétroactivement l'historique et le chiffre de la semaine dernière
 * changerait tout seul. La ligne est un fait daté, pas une vue sur le catalogue actuel.
 */
export const citadelBusinessSaleLines = mysqlTable(
  CT.businessSaleLines,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    saleId: bigint("sale_id", { mode: "number" }).notNull(),
    itemId: bigint("item_id", { mode: "number" }),
    label: varchar("label", { length: 120 }).notNull(),
    category: varchar("category", { length: 60 }).notNull(),
    qty: int("qty").notNull(),
    unitPriceCents: int("unit_price_cents").notNull(),
    unitCommissionCents: int("unit_commission_cents").default(0).notNull(),
    /**
     * CE QUE LA PIÈCE A COÛTÉ À LA SOCIÉTÉ, en centimes. NULLABLE, et les trois états comptent.
     *
     * Renseigné uniquement par `declareCustomSale`: une tournée de bar et une vidange au forfait
     * n'ont pas de coût mesurable, et y écrire 0 affirmerait une marge de 100 % sur une ligne dont
     * personne n'a jamais connu le prix de revient. NULL veut dire "pas mesurable ici", jamais
     * "gratuit". Même distinction, et même raison, que le tri-état de `vehicle_record`.
     *
     * ⚠ COPIÉ, PAS RECALCULÉ, exactement comme `unit_price_cents` juste au-dessus. Le coût dépend
     * de `esx_lscustom/config.lua`, qui est éditable dans le jeu: recalculer demain le coût d'hier
     * réécrirait la marge affichée sur un ticket déjà remis au client. Un ticket est un fait daté.
     */
    unitCostCents: int("unit_cost_cents"),
  },
  (t) => [index("idx_business_sale_lines_sale").on(t.saleId)],
);

/**
 * Les pointages. ÉCRITE PAR LE JEU, migrée par CITADEL (même contrat que citadel_cad_presence).
 *
 * ⚠⚠ Cette table porte DEUX rôles volontairement confondus, et c'est la décision de conception:
 *   1. l'historique des services, c'est-à-dire la fiche de pointage;
 *   2. la porte "en service" du portail, car une ligne ouverte au heartbeat frais EST la preuve
 *      d'être en service.
 * Les tenir dans deux tables garantirait qu'elles divergent un jour, et quelqu'un finirait en
 * service sans pointage, ou pointé sans être en service.
 *
 * ⚠ `endedReason` n'est pas décoratif. Aujourd'hui InService et ServiceSince vivent en mémoire dans
 * gs_jobs et un plantage ne ferme jamais rien: sans motif, un service interrompu par un crash
 * ressemble définitivement à une journée courte. Le balayage au boot doit fermer les lignes
 * orphelines sur le DERNIER HEARTBEAT et non sur l'heure courante, sinon un plantage serveur
 * crédite des heures à toute l'équipe.
 *
 * `heartbeatAt` rend le balayage possible ET fait expirer la porte "en service": un serveur qui
 * tombe laisse les leases pourrir d'elles-mêmes, exactement comme cad_presence.expires_at.
 */
export const citadelBusinessShifts = mysqlTable(
  CT.businessShifts,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** Nom de métier ESX, et non businessId: le jeu ne connaît que le métier, et un pointage doit
     *  pouvoir s'ouvrir même si le portail n'est pas encore activé pour ce commerce. */
    job: varchar("job", { length: 60 }).notNull(),
    identifier: varchar("identifier", { length: 60 }).notNull(), // hex nu
    name: varchar("name", { length: 120 }).notNull(), // copie au moment de la prise de service
    grade: int("grade").default(0).notNull(),
    serverId: int("server_id"),
    startedAt: createdNow("started_at"),
    endedAt: nullableDate("ended_at"),
    endedReason: mysqlEnum("ended_reason", [
      "debauche", // fin de service volontaire
      "deconnexion", // playerDropped
      "afk", // gs_antiAfk a retiré le service
      "crash_sweep", // ligne orpheline fermée au boot, sur le dernier heartbeat
      "job_change", // changement de métier sans débauche
      /**
       * Le patron a poussé l'employé hors service (`gs_jobs:disableEmployeeService`).
       *
       * ⚠ AJOUTÉ PARCE QUE LA CORRESPONDANCE ÉTAIT LOSSY, et sur une fiche de paie. Sans cette
       * valeur, une mise hors service SUBIE se rangeait sous `debauche`, qui veut dire "il est
       * parti de lui-même": l'employé lit sa fiche et y voit une décision qu'il n'a pas prise.
       * Ce n'est pas cosmétique, c'est la seule trace de qui a mis fin au service.
       *
       * ⚠ On ne pouvait pas la laisser NON mappée: une valeur hors énumération fait ÉCHOUER
       * l'UPDATE en mode strict, et un close qui échoue laisse la ligne OUVERTE, donc laisse un
       * droit d'écriture sur le portail à quelqu'un que le patron vient de renvoyer chez lui.
       */
      "force_off",
    ]),
    heartbeatAt: createdNow("heartbeat_at"),
  },
  (t) => [
    index("idx_business_shifts_job_start").on(t.job, t.startedAt),
    index("idx_business_shifts_person").on(t.identifier, t.startedAt),
    // Sert la porte "en service": les lignes ouvertes, triées par fraîcheur.
    index("idx_business_shifts_open").on(t.endedAt, t.heartbeatAt),
  ],
);

/**
 * LE BAREME DE MARGE DES CUSTOMS: ce que le garage ajoute au coût des pièces, et qui le décide.
 *
 * Règle du propriétaire (2026-08-23), mot pour mot: *"the margin they should add for themselves on
 * each custom shouldnt be the same per car or per custom on a car. they should be defined by me and
 * not modifiable by them"*.
 *
 * ⚠⚠ POURQUOI UNE TABLE À PART ET PAS UNE COLONNE SUR `lifeinvader_businesses`. Cette ligne-là est
 * relue et RÉÉCRITE EN ENTIER par la page Réglages du patron (`sanitizeCommission`,
 * lib/business/commission.ts) - `commission.vehicleProfitBps` y est déjà, et il est éditable par le
 * commerce par construction. Y déposer le barème le rendrait modifiable par ceux qu'il contraint,
 * c'est-à-dire exactement l'inverse de la règle. La séparation n'est donc pas un rangement, c'est
 * l'application de la règle: aucune Server Action de `/business/` ne connaît cette table.
 *
 * ⚠ ET PAS NON PLUS `citadel_config`. Ce magasin-là est gardé par `citadel.config`, un code de
 * catalogue ordinaire qu'un Admin peut détenir, et sa page liste toutes ses lignes. Le barème est
 * gardé par `CODES.BUSINESS_MARGIN`, Fondateur par construction (listé dans aucun bloc de rang,
 * atteignable seulement par le '*'), même idiome que `BUSINESS_ADMIN` et `DISCORD_BROADCAST`.
 *
 * ── LE MODÈLE: UNE DROITE, PAS UN MULTIPLICATEUR ────────────────────────────────────────────────
 *
 *     prix_client = coût_pièces × (rate_bps / 10000) + labour_cents
 *
 * Le multiplicateur que le propriétaire décrit ("×8 sur la peinture d'une Primo, +20 % sur son
 * moteur 4") n'est PAS un réglage: il se déduit, `m = rate + labour/coût`. C'est le forfait fixe qui
 * se dilue quand le chantier grossit, donc un petit travail porte mécaniquement une grosse marge et
 * un gros travail une marge fine, sans que personne n'écrive un chiffre par voiture. Les deux
 * valeurs par défaut (11103 et 61300) sont l'ajustement exact de ses deux ancres: peinture Primo
 * 89 $ -> 712 $, moteur 4 Primo 6 842 $ -> 8 210 $.
 *
 * ── LA PORTÉE: QUATRE AXES NULLABLES, LE PLUS SPÉCIFIQUE GAGNE ──────────────────────────────────
 *
 * Une colonne de portée à NULL veut dire "sur cet axe, cette règle s'applique à tout". La règle
 * GLOBALE est donc la ligne dont les quatre axes sont NULL, et c'est la seule qui soit obligatoire.
 *
 * ⚠ IL DOIT TOUJOURS EXISTER UNE LIGNE GLOBALE. Sans elle, une cotation ne résout aucune règle, et
 * `quoteCustoms` REFUSE de coter plutôt que de supposer une marge (même discipline que le refus
 * `no_ceiling` de `declareFreeSale`, qui n'invente jamais un plafond absent). Un garage qui ne peut
 * plus rien facturer est un incident visible en une minute; un garage qui facture une marge devinée
 * ne se voit jamais.
 *
 * ⚠ LE POIDS DES AXES EST UN ORDRE TOTAL, ET IL EST DÉLIBÉRÉ: modèle 8, catégorie 4, slot 2,
 * palier 1, additionnés. Donc `modèle+slot` (10) bat `modèle` seul (8), qui bat
 * `catégorie+slot+palier` (7): NOMMER UNE VOITURE PRÉCISE EST PLUS SPÉCIFIQUE QUE NOMMER SA CLASSE,
 * même quand l'autre règle descend jusqu'au palier. À égalité, la ligne la plus RÉCENTE gagne, pour
 * qu'une correction se fasse en ajoutant une ligne et jamais en cherchant laquelle éditer.
 */
export const citadelMarginRules = mysqlTable(
  CT.marginRules,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * Le code de spawn du véhicule (`primo`), c'est-à-dire la clé de `fleetRoster.generated.json`.
     * JAMAIS le nom affiché: "Primo" et "Primo Custom" sont deux voitures et deux prix.
     */
    vehicleModel: varchar("vehicle_model", { length: 60 }),
    /** La catégorie du roster (`super`, `sedans`, `motorcycles`). */
    vehicleCategory: varchar("vehicle_category", { length: 32 }),
    /** La clé Config.Menus (`modEngine`). Voir lib/business/customPricing.ts. */
    slotKey: varchar("slot_key", { length: 60 }),
    /**
     * L'INDEX GTA du palier, pas le numéro affiché: le "moteur niveau 4" est le palier 3.
     * NULL = tous les paliers de ce slot. Voir l'avertissement sur `CustomTier.level`.
     */
    slotLevel: int("slot_level"),
    /** Le taux, en points de base du coût des pièces. 11103 = ×1,1103. */
    rateBps: int("rate_bps").notNull(),
    /** Le forfait de main d'oeuvre ajouté à chaque ligne, en centimes. 61300 = 613 $. */
    labourCents: int("labour_cents").notNull(),
    /**
     * PLAFOND OPTIONNEL, en points de base de la VALEUR DU VÉHICULE, jamais du coût.
     *
     * ⚠ C'est ce qui empêche le bas de gamme de déraper: sur une moto à 1 000 $, une peinture coûte
     * 11 $ de pièces et le seul forfait la ferait sortir à 613 $, soit 61 % de l'engin. Exprimé en
     * part du véhicule, le plafond dit quelque chose de vrai sur toute la gamme, ce qu'un plafond en
     * dollars ne peut pas faire quand les voitures vont de 3 000 $ à 12 000 000 $.
     * NULL = aucun plafond, ce qui est un choix explicite et non un oubli.
     */
    capBpsOfVehicle: int("cap_bps_of_vehicle"),
    /** Pourquoi cette exception existe. Pour le propriétaire dans six mois, pas pour le code. */
    note: varchar("note", { length: 200 }),
    /** Le compte staff qui a écrit la ligne. Une décision de prix a un auteur. */
    updatedBy: bigint("updated_by", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    /**
     * ⚠ UNE SEULE RÈGLE PAR PORTÉE, garantie par la base et pas par l'écran. Deux lignes de même
     * portée rendraient le prix dépendant de l'ordre de lecture, donc silencieusement instable d'un
     * rendu à l'autre. MySQL traite chaque NULL comme distinct dans un index unique, ce qui
     * n'attrape PAS le doublon de la ligne globale (quatre NULL): `putRule` s'en charge en amont.
     */
    uniqueIndex("uq_margin_rules_scope").on(t.vehicleModel, t.vehicleCategory, t.slotKey, t.slotLevel),
  ],
);


/* ── HISTORIQUE D'APPARTENANCE AUX FACTIONS ──────────────────────────────────────────────────────
 * "logs should [not] get removed from a faction's logs when the player is no longer part of it or
 * gets wiped. those logs should stay as they happened when the player was in there." (owner)
 *
 * ── LE DÉFAUT QUE CETTE TABLE CORRIGE ───────────────────────────────────────────────────────────
 * `gs_logs` n'a AUCUNE portée de faction: pas de colonne `job`, et le blob `data` ne porte un nom de
 * métier que sur ~9,5 % des lignes, de façon incohérente (lib/data/logs.ts:442-457 le documente).
 * Le fil d'une faction se construisait donc à partir de l'EFFECTIF ACTUEL - `rosterFor(job)` lit
 * `users.job`/`job2`, puis les lignes sont filtrées sur cette liste d'identifiants. Or le jeu ÉCRASE
 * ces deux colonnes: dès qu'une personne quitte la faction, change de métier, ou passe par un MortRP
 * (qui remet les deux slots à 'unemployed', gs_identity/server/mortrp.lua:940-941), TOUT ce qu'elle a
 * jamais fait disparaît de la vue de sa faction. Les transferts d'objets partent avec, ce qui est
 * exactement le "can get lost and not seen by staff" décrit.
 *
 * ⚠ LES LIGNES DE LOG, ELLES, N'ONT JAMAIS ÉTÉ SUPPRIMÉES. Le MortRP conserve `gs_logs` par choix
 * explicite (mortrp.lua:4) et ne supprime pas la ligne `users`. Le défaut est donc entièrement dans
 * l'ATTRIBUTION, pas dans la conservation: les données existent, la requête ne sait plus les trouver.
 * C'est ce qui rend le correctif possible côté CITADEL seul.
 *
 * ── LE MODÈLE: DES SÉJOURS, PAS UN ÉTAT ─────────────────────────────────────────────────────────
 * Une ligne = UN SÉJOUR d'une personne dans une faction, sur un slot donné. `left_at IS NULL` = elle
 * y est encore. Une personne qui part puis revient a deux lignes, jamais une ligne modifiée: c'est ce
 * qui permet de borner ses logs à la période où elle y était vraiment, et donc de ne PLUS afficher
 * ses actions d'aujourd'hui chez son ancien employeur.
 *
 * ⚠⚠ `joined_at_estimated` EST LA COLONNE QUI EMPÊCHE UNE RÉGRESSION, pas un détail de confort.
 * L'historique ne peut pas être reconstitué: rien n'a jamais enregistré la date d'entrée des membres
 * actuels. Au premier passage, chaque membre existant reçoit donc un séjour ouvert daté de MAINTENANT
 * - et si cette date servait de borne basse, tout ce que l'effectif actuel a fait AVANT la migration
 * disparaîtrait du fil. Ce serait perdre des logs pour en sauver d'autres. Un séjour marqué
 * `joined_at_estimated = 1` n'applique donc AUCUNE borne basse: la vue reste exactement ce qu'elle est
 * aujourd'hui pour les membres présents, et gagne la rétention pour ceux qui partiront ensuite.
 *
 * ── CE QUI NE PEUT PAS ÊTRE RATTRAPÉ, ET IL FAUT LE DIRE ────────────────────────────────────────
 * Toute personne DÉJÀ PARTIE avant la mise en service de cette table est irrécupérable: son passage
 * n'a laissé aucune trace nulle part (`users` a été écrasé, et aucune ligne de log ne porte le
 * métier). Aucun backfill n'est possible et il ne faut pas en simuler un. La rétention commence au
 * premier balayage, pas avant.
 *
 * ÉCRIT PAR: le balayage de lib/data/factionMembership.ts (processus web, démarré par
 * instrumentation.ts), qui compare `users` à cette table. Le jeu n'écrit jamais ici.
 */
export const citadelFactionMembership = mysqlTable(
  CT.factionMembership,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Hex nu, joint users.identifier PAR VALEUR (collations différentes: jamais de JOIN colonne à
    // colonne, voir lib/db/collation.ts).
    identifier: varchar("identifier", { length: 60 }).notNull(),
    job: varchar("job", { length: 64 }).notNull(),
    // Les deux slots d'emploi d'ESX. Un membre peut tenir la même faction sur un seul des deux; les
    // séparer évite qu'un changement sur job2 close par erreur le séjour ouvert sur job.
    slot: mysqlEnum("slot", ["job", "job2"]).notNull(),
    grade: int("grade"),
    // Nom RP au dernier relevé. Le fil de logs porte déjà `source_name`, mais le SÉLECTEUR d'acteur de
    // l'onglet Logs se construit à partir de l'effectif: sans ce nom, un ancien membre serait
    // filtrable par identifiant seulement, c'est-à-dire pas filtrable.
    playerName: varchar("player_name", { length: 255 }),
    joinedAt: createdNow("joined_at"),
    // 1 = nous n'avons PAS vu l'entrée (séjour initialisé au premier balayage). Aucune borne basse
    // n'est appliquée dans ce cas - voir l'avertissement de l'en-tête.
    joinedAtEstimated: boolean("joined_at_estimated").default(false).notNull(),
    // NULL = toujours membre. Renseigné au premier balayage qui ne voit plus la paire.
    leftAt: nullableDate("left_at"),
    lastSeenAt: createdNow("last_seen_at"),
  },
  (t) => [
    // La requête du fil: "tous les séjours de cette faction", ouverts d'abord.
    index("idx_faction_membership_job").on(t.job, t.leftAt),
    index("idx_faction_membership_person").on(t.identifier, t.job),
    // Le balayage résout un séjour OUVERT pour une paire donnée; l'unicité ne peut pas être un index
    // unique partiel (MariaDB n'en a pas), donc elle est tenue par le balayage lui-même, qui ferme
    // toujours avant d'ouvrir.
    index("idx_faction_membership_open").on(t.leftAt, t.lastSeenAt),
  ],
);

/* -- SALONS DE LEAD (2026-08-21) ------------------------------------------------------------- */

/**
 * LA LIAISON: un metier, un salon Discord prive partage avec son ou ses leads et le staff.
 *
 * POURQUOI UNE TABLE ET PAS UNE CLE citadel_config. Le mapping VIP tient dans une cle JSON parce
 * qu'il vaut trois lignes; ici c'est jusqu'a 154 metiers, chacun avec sa grille de grades, son
 * registre d'acces et son etat de synchronisation, edite depuis la fiche de chaque faction. Une
 * cle JSON de 154 entrees se relit entierement pour ecrire une seule liaison et perd la premiere
 * ecriture concurrente sans rien dire.
 *
 * `channelId` EST UNIQUE, et ce n'est pas de la coquetterie. Deux metiers pointant le meme salon
 * font que le balayeur de chacun considere les leads de l'autre comme des intrus et leur retire
 * l'acces, en boucle, a chaque tour. L'unicite transforme cette panne silencieuse en refus a la
 * liaison, la ou un humain peut la lire.
 *
 * Le GUILD est stocke a cote du salon plutot que deduit a la lecture: `citadel_discord_channels`
 * est un CACHE que la decouverte purge quand le bot perd un salon, et une liaison ne doit pas
 * devenir illisible parce que son cache a ete vide.
 */
export const citadelJobChannels = mysqlTable(
  CT.jobChannels,
  {
    /** `jobs.name`. C'est la PK: la table jobs n'a pas d'id de substitution, son nom EST sa cle. */
    jobName: varchar("job_name", { length: 64 }).notNull().primaryKey(),
    guildId: varchar("guild_id", { length: 32 }).notNull(),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    /**
     * La categorie au moment de la liaison. Sert au ROLE SUPPLEMENTAIRE (Lead Faction pour
     * l'illegal, Responsable Service Publique pour le service public): la famille du metier se
     * DEDUIT de sa categorie plutot que d'etre saisie une seconde fois par metier, donc elle ne
     * peut pas contredire la realite Discord. Rafraichie a chaque synchronisation.
     */
    parentId: varchar("parent_id", { length: 32 }),
    /** Faux = liaison conservee, balayage suspendu. Delier PERD la grille de grades; suspendre non. */
    enabled: boolean("enabled").default(true).notNull(),
    /** Faux = ce salon ne recoit jamais de message d'accueil, meme pour un nouveau lead. */
    welcomeEnabled: boolean("welcome_enabled").default(true).notNull(),
    linkedBy: bigint("linked_by", { mode: "number" }),
    linkedAt: createdNow("linked_at"),
    /** Quand le bot a reconcilie ce salon pour la derniere fois. NULL = jamais. */
    lastSyncAt: nullableDate("last_sync_at"),
    /**
     * Le dernier refus de Discord, en clair, ou NULL si le dernier passage a reussi. Une liaison
     * qui echoue en silence est le pire etat possible ici: le panneau afficherait un effectif
     * theorique pendant que le salon reel n'a jamais bouge.
     */
    lastSyncError: varchar("last_sync_error", { length: 255 }),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [uniqueIndex("uq_job_channel_channel").on(t.channelId)],
);

/**
 * QUELS GRADES donnent l'acces. Une ligne par rung coche.
 *
 * DES LIGNES ET PAS UN SEUIL `grade >= n`, parce que les grilles reelles ont des TROUS: LSPD va
 * 0..13 puis saute directement a 15 (Commandant), sans 14. Un seuil "a partir de Major (11)"
 * donnerait l'acces au rung 14 le jour ou quelqu'un le cree, sans que personne ne l'ait decide. La
 * demande du proprietaire etait litteralement une case a cocher par grade; c'est ce que ca stocke.
 *
 * Le numero de rung est reference SANS cle etrangere, comme partout ailleurs pour job_grades (voir
 * l'en-tete de GradesPanel.tsx: la grille est append-only justement parce que ces numeros sont
 * references sans FK un peu partout). Un rung supprimee laisse une ligne inerte ici, jamais une
 * erreur, et le panneau l'affiche comme inconnue plutot que de planter.
 */
export const citadelJobChannelGrades = mysqlTable(
  CT.jobChannelGrades,
  {
    jobName: varchar("job_name", { length: 64 }).notNull(),
    grade: int("grade").notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobName, t.grade] })],
);

/**
 * LE REGISTRE D'ACCES: qui detient l'acces a quel salon, depuis quand, et a-t-il deja ete accueilli.
 *
 * POURQUOI IL EXISTE PLUTOT QUE DE RELIRE DISCORD. Trois questions auxquelles Discord ne repond
 * pas, et dont deux sont des fonctionnalites demandees:
 *   1. "Est-il NOUVEAU ?" Une permission-overwrite ne porte pas de date. Sans registre, le balayeur
 *      ne peut pas distinguer un lead promu il y a dix secondes d'un lead present depuis un mois,
 *      donc ne peut pas grouper les arrivees d'une meme fenetre de 30 s en un seul message.
 *   2. "A-t-il deja ete accueilli ?" Meme probleme, en pire: sans marqueur, chaque passage du
 *      balayeur re-pingue tout le monde.
 *   3. "Etait-il la ?" Un acces retire ne laisse aucune trace cote Discord, donc aucune trace de qui
 *      a eu acces a quoi et quand, ce qui est exactement le genre de chose qu'un staff doit pouvoir
 *      reconstituer plus tard.
 *
 * UNE LIGNE PAR (metier, personne), REUTILISEE, pas une ligne par periode d'acces. MariaDB n'a pas
 * d'index unique partiel, donc "un seul acces actif par personne" ne peut pas etre tenu par un
 * index sur les seules lignes vivantes; la contrainte est portee par la cle unique complete, et le
 * balayeur reouvre la ligne existante au lieu d'en inserer une seconde.
 *
 * `welcomedAt` EST REMIS A NULL A LA REOUVERTURE, deliberement. Quelqu'un qui perd son grade puis
 * le retrouve trois mois plus tard n'a aucune raison de se souvenir du salon: il est re-accueilli.
 * Le cout d'un message de trop est nul, celui d'un lead qui ignore qu'il a un salon ne l'est pas.
 */
export const citadelJobChannelAccess = mysqlTable(
  CT.jobChannelAccess,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    jobName: varchar("job_name", { length: 64 }).notNull(),
    /** Hex nu (`users.identifier`), jamais `license:xxx`. Joint PAR VALEUR, collations differentes. */
    identifier: varchar("identifier", { length: 60 }).notNull(),
    /**
     * Le snowflake resolu au moment de l'octroi. Redonde avec citadel_identifiers a dessein: c'est
     * l'adresse a laquelle l'acces a REELLEMENT ete ecrit, et si la personne relie plus tard un
     * autre compte Discord, il faut pouvoir retirer l'ancien overwrite, pas le nouveau.
     */
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    /** Le rung qui justifiait l'acces au dernier balayage. Affiche, et utile a la relecture. */
    grade: int("grade"),
    /** Nom RP au dernier relevé, pour que le registre reste lisible apres un depart. */
    playerName: varchar("player_name", { length: 255 }),
    grantedAt: createdNow("granted_at"),
    /** NULL = acces actif. Renseigne par le balayage qui ne voit plus la personne au bon grade. */
    revokedAt: nullableDate("revoked_at"),
    /**
     * Quand le retrait a ete REELLEMENT ecrit dans Discord. NULL = il reste a faire.
     *
     * `revokedAt` est une DECISION de CITADEL, celle-ci est un FAIT cote Discord, et confondre les
     * deux casse dans un sens ou dans l'autre: retenter toutes les lignes revoquees a chaque
     * passage fait grossir le travail avec l'historique du metier, et ne jamais retenter laisse un
     * ancien lead dans le salon pour toujours apres une seule coupure reseau. Voir 0074.
     *
     * ⚠ RENSEIGNEE APRES l'ecriture Discord, jamais avant.
     */
    revokeAppliedAt: nullableDate("revoke_applied_at"),
    /** NULL = accueil du au prochain passage (apres la fenetre de regroupement). */
    welcomedAt: nullableDate("welcomed_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_job_channel_access").on(t.jobName, t.identifier),
    // La requete du balayeur: "les acces actifs de ce metier".
    index("idx_job_channel_access_live").on(t.jobName, t.revokedAt),
  ],
);


/**
 * LE compte Discord d'une personne, quand elle en a plusieurs.
 *
 * ⚠ CE N'EST PAS UNE PREFERENCE COSMETIQUE. `discordIdForAccount` prenait la premiere ligne rendue
 * par MySQL sur un SELECT sans ORDER BY, donc un ordre non defini. Mesure en production le
 * 2026-08-21: 12 comptes portent deux identifiants Discord et, sur les 5 leads concernes, le tirage
 * designait le mauvais compte dans au moins 3 cas (un compte a 11 sessions abandonne depuis un mois
 * plutot que celui a 920 sessions utilise le jour meme). L'acces Discord etait donc accorde a une
 * identite que la personne n'ouvre jamais, sans que rien ne puisse le signaler.
 *
 * ⚠ CLE SUR LE COMPTE, PAS SUR LA LICENCE NI SUR LE METIER, et la mesure impose les trois: un
 * compte porte parfois plusieurs licences (10 cas), deux personnages partagent parfois un compte
 * (Jose Garcia et Marco Morales), et la question posee ("lequel de ses Discord est le sien") ne
 * depend evidemment pas de son emploi. Un choix par metier se contredirait d'une fiche a l'autre.
 *
 * Absence de ligne = pas de choix explicite: la resolution retombe alors sur un ordre DETERMINISTE
 * (le plus recemment vu, puis le plus utilise), qui est deja bien meilleur qu'un tirage arbitraire.
 * Un `discordId` qui ne correspond plus a aucun identifiant connu est IGNORE, jamais une erreur.
 */
export const citadelDiscordPrimary = mysqlTable(CT.discordPrimary, {
  accountId: bigint("account_id", { mode: "number" }).notNull().primaryKey(),
  discordId: varchar("discord_id", { length: 32 }).notNull(),
  /** citadel_users.id du staff qui a tranche. NULL = choix pose par un script/migration. */
  setBy: bigint("set_by", { mode: "number" }),
  setAt: createdNow("set_at"),
});

/* ── L'ATELIER MIRAGE: dépôt d'assets de jeu ─────────────────────────────────
 * Conception: _server_build/DESIGN_2026-08-24_mirage_asset_portal.md.
 *
 * Un employé MIRAGE dépose des fichiers, le staff approuve, le worker .NET construit un pack de
 * STAGING sur le disque, et le propriétaire le met en ligne en tapant lui-même la commande. Décision
 * du propriétaire, verbatim: *"never auto restarts. it will make people crash"*. Rien dans ces
 * tables ne déclenche donc quoi que ce soit côté serveur de jeu, et il n'existe aucune colonne
 * "publié": la mise en ligne n'est pas un état que le panel puisse connaître.
 *
 * ⚠ LE COÛT EN POOLS EST FIGÉ À LA SOUMISSION (`pool_cost`), pas recalculé à l'approbation. Le
 * fichier peut être relu, la marge du serveur ne peut pas l'être rétroactivement: le staff doit voir
 * ce que ce dépôt coûte, et `lib/assets/pools.ts` fournit séparément la marge du MOMENT où il
 * approuve. Les deux chiffres répondent à deux questions et les confondre ferait approuver contre
 * une marge périmée.
 */
export const citadelAssetSubmissions = mysqlTable(
  CT.assetSubmissions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * ⚠ `bag_import` (Atelier Forge v2, suivi 2026-08-26) est un kind ZERO-FICHIER: les sources
     * vivent dans un dossier de dump inerte (`resources/bags`, `resources/bags2`), pas dans le dépôt.
     * Le dépôt ne porte que sa cible dans `target_ref` ({ dumpRoot, drawableId, label }); le moteur
     * écrit le drawable + ses textures dans `gs_bag_assets` (un nouvel emplacement de modèle). Voir
     * la migration 0087_bag_import.sql.
     */
    kind: mysqlEnum("kind", ["tattoo", "bag_texture", "clothing", "bag_import"]).notNull(),
    /**
     * AJOUT ou MODIFICATION d'un asset existant (Atelier Forge v2). Un `modify` renomme/reprice un
     * tatouage ou ajoute un coloris; `target_ref` porte alors ce qui est visé (collection + Name,
     * base de mesh + id, composant). NULL pour un simple ajout neuf. Voir
     * DESIGN_2026-08-26_atelier_forge_v2.md section 9.
     */
    operation: mysqlEnum("operation", ["add", "modify"]).default("add").notNull(),
    targetRef: parsedJson<Record<string, unknown>>()("target_ref"),
    /** La ressource à laquelle ce dépôt s'ajoute, figée depuis ASSET_KIND_SPECS à la soumission. */
    targetResource: varchar("target_resource", { length: 64 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    notes: text("notes"),
    /**
     * ⚠ PAS DE STATUT "PUBLIÉ", ET C'EST STRUCTUREL. `staged` est le dernier état que ce panel peut
     * observer: au-delà, c'est le propriétaire qui tape `refresh` puis `ensure` dans sa console, et
     * rien ici ne peut le savoir. Une colonne "en ligne" serait une affirmation invérifiable.
     */
    status: mysqlEnum("status", ["pending", "approved", "rejected", "staged", "failed", "applied"])
      .default("pending")
      .notNull(),
    /** Le compte CITADEL qui a déposé, et le personnage MIRAGE au moment du dépôt. */
    authorAccountId: bigint("author_account_id", { mode: "number" }).notNull(),
    authorIdentifier: varchar("author_identifier", { length: 60 }).notNull(), // hex nu, joint users.identifier
    /** Nom RP figé à la soumission: le personnage peut changer de nom, la trace ne doit pas bouger. */
    authorName: varchar("author_name", { length: 80 }).notNull(),
    fileCount: int("file_count").default(0).notNull(),
    bytes: bigint("bytes", { mode: "number" }).default(0).notNull(),
    /** { ".ytd": n, ".ydd": n, … } au moment du dépôt. Voir la remarque en tête de bloc. */
    poolCost: parsedJson<Record<string, number>>()("pool_cost"),
    /** Le dossier de dépôt sur le disque de la VM, relatif à la racine de staging. */
    intakePath: varchar("intake_path", { length: 255 }).notNull(),
    reviewedByAccountId: bigint("reviewed_by_account_id", { mode: "number" }),
    reviewedAt: nullableDate("reviewed_at"),
    /** Obligatoire au refus: un dépôt rejeté sans motif est une impasse pour la personne. */
    reviewReason: varchar("review_reason", { length: 500 }),
    /** Renseigné quand le worker a écrit le pack de staging, avec la commande à taper. */
    stagedPath: varchar("staged_path", { length: 255 }),
    stagedAt: nullableDate("staged_at"),
    /** Le message d'échec du worker, montré tel quel au staff. */
    failureReason: varchar("failure_reason", { length: 500 }),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"),
  },
  (t) => [
    index("idx_asset_sub_status").on(t.status, t.id),
    index("idx_asset_sub_author").on(t.authorAccountId, t.id),
    index("idx_asset_sub_kind").on(t.kind, t.status),
  ],
);

/**
 * Un fichier d'un dépôt.
 *
 * ⚠ `sha256` N'EST PAS DE LA DÉCORATION: c'est ce qui permet de dire qu'un fichier approuvé et le
 * fichier construit par le worker sont le même octet pour octet. Sans lui, "approuvé" ne désigne
 * rien de précis.
 *
 * ⚠ `issues` GARDE LE VERDICT DU MOMENT DU DÉPÔT. Les règles de `lib/assets/validate.ts` évoluent;
 * ce qu'on a montré à la personne, et ce sur quoi le staff a tranché, ne doit pas se réécrire tout
 * seul quand une règle change. Même raison que `delivered_as` sur les tickets.
 */
export const citadelAssetFiles = mysqlTable(
  CT.assetFiles,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    submissionId: bigint("submission_id", { mode: "number" }).notNull(),
    filename: varchar("filename", { length: 180 }).notNull(),
    ext: varchar("ext", { length: 8 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    issues: parsedJson<unknown[]>()("issues"),
    /**
     * LA FICHE D'AUTEUR: nom affiché, zone, prix pour un tatouage; `null` pour un sac, qui n'a rien
     * à décider (FiveM le détecte à son nom de fichier).
     *
     * ⚠ JSON et pas trois colonnes: la fiche diffère par TYPE d'asset, et figer la forme du seul
     * type existant obligerait à une migration par type ajouté.
     */
    meta: parsedJson<Record<string, unknown>>()("meta"),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    index("idx_asset_file_sub").on(t.submissionId),
    // Le même octet déposé deux fois dans un dépôt est une erreur de manipulation, pas une variante.
    uniqueIndex("uq_asset_file_name").on(t.submissionId, t.filename),
  ],
);

/**
 * CE QUI A ÉTÉ ÉCRIT SUR LE DISQUE, et l'anse pour le défaire (Atelier Forge v2).
 * Conception: _server_build/DESIGN_2026-08-26_atelier_forge_v2.md, sections 6.3 et 9.
 *
 * ⚠ C'EST LE "record exactly what was written" DE LA RÈGLE PROPRIÉTAIRE. Le moteur C# (ChangeSet)
 * écrit de façon transactionnelle et rend un `ChangeResult`; on persiste ici son `transaction_id`,
 * la liste des fichiers touchés, l'état de rollback et la référence de sauvegarde. Une ligne par
 * transaction appliquée: un dépôt multi-fichiers peut en produire plusieurs.
 *
 * ⚠ ON NE SUPPRIME JAMAIS UNE LIGNE. Un rollback renseigne `rolled_back_at` et met `rollback_status`
 * à jour; la ligne reste la trace de ce qui a été écrit puis défait. `transaction_id` est l'anse
 * rendue au moteur pour ce rollback (`ChangeSet.Rollback`), d'où l'index dessus.
 */
export const citadelAssetApplied = mysqlTable(
  CT.assetApplied,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    submissionId: bigint("submission_id", { mode: "number" }).notNull(),
    /** Format moteur `^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}$`. varchar large par sécurité. */
    transactionId: varchar("transaction_id", { length: 40 }).notNull(),
    engineVersion: varchar("engine_version", { length: 32 }),
    /** `[{ path, op, sizeBefore, sizeAfter, success, detail }]` issus du ChangeResult. */
    files: parsedJson<unknown[]>()("files"),
    /** `FullyRolledBack` / `Incomplete` côté moteur, ou `null` tant qu'aucun rollback n'a eu lieu. */
    rollbackStatus: varchar("rollback_status", { length: 24 }),
    /** `<backupRoot>/<transactionId>/` : où le TransactionLedger a sauvegardé avant d'écrire. */
    backupRef: varchar("backup_ref", { length: 255 }),
    appliedByAccountId: bigint("applied_by_account_id", { mode: "number" }),
    appliedAt: createdNow("applied_at"),
    rolledBackAt: nullableDate("rolled_back_at"),
  },
  (t) => [
    index("idx_asset_applied_sub").on(t.submissionId),
    index("idx_asset_applied_txn").on(t.transactionId),
  ],
);

/**
 * Source de vignette pour le sélecteur visuel du web. Cosmétique: ne pilote jamais l'équipement.
 * Tous les champs sont optionnels (une entrée saisie au numéro à la main n'a aucune ref).
 */
export type GenderRegistryRef = {
  resource?: string;
  ydd?: string;
  ytd?: string;
  name?: string;
};

/**
 * LE REGISTRE DES OBJETS GENRÉS (sacs v1, vêtements v1.5).
 * Conception: _server_build/DESIGN_2026-08-27_gender_registry.md, sections 3 et 4.
 * Migration: drizzle/0090_gender_registry.sql.
 *
 * Une ligne = { kind, component, label, male {drawable, texture?}, female {drawable, texture?}, refs? },
 * un des deux côtés au moins présent. L'appariement se fait au niveau du DRAWABLE (même forme que
 * Config.BagGenderMatching, la texture suit par index côté équipement). gs_bags relit les lignes
 * actives (motif penalCodeSync) et régénère Config.BagGenderMatching + Config.BagsLabel; les
 * métadonnées d'item ne sont jamais touchées, l'id canonique reste le masculin.
 *
 * ⚠ `male_ref`/`female_ref` sont PUREMENT COSMÉTIQUES: la source de vignette du sélecteur visuel web.
 *   Les NUMÉROS font foi, jamais la ref.
 *
 * ⚠ `canonicalDrawable` est GÉNÉRÉE STORED côté SQL (COALESCE(male_drawable, female_drawable)): jamais
 *   écrite depuis le code, seulement lue. C'est la clé de libellé/alias. L'unicité parmi les lignes
 *   actives est (kind, component, canonical, male_texture): plusieurs coloris du même drawable sont
 *   des entrées distinctes, fusionnées dans BagsLabel par le poll gs_bags.
 */
export const citadelGenderRegistry = mysqlTable(
  CT.genderRegistry,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** 'bag' aujourd'hui; 'clothing' en v1.5 (schéma prêt, consommateur jeu en suivi). */
    kind: mysqlEnum("kind", ["bag", "clothing"]).default("bag").notNull(),
    /** Composant ped: 'bags_1' pour un sac, un composant vêtement (ex. 'torso_1') en v1.5. */
    component: varchar("component", { length: 24 }).default("bags_1").notNull(),
    /** <= 40, le même plafond qu'aux trois clamps existants (gs_bags_instances.label, les deux Lua). */
    label: varchar("label", { length: 40 }).notNull(),
    /** Drawable live du composant 5 (masculin). Borné [0, BAG_SKIN_MAX_DRAWABLE] côté données. */
    maleDrawable: int("male_drawable"),
    /** Optionnel: scope le libellé à une texture précise. Ne pilote pas l'équipement en v1. */
    maleTexture: int("male_texture"),
    femaleDrawable: int("female_drawable"),
    femaleTexture: int("female_texture"),
    /** Vignette cosmétique {resource, ydd, ytd, name}. Ne pilote jamais l'équipement. */
    maleRef: parsedJson<GenderRegistryRef>()("male_ref"),
    femaleRef: parsedJson<GenderRegistryRef>()("female_ref"),
    /** Soft delete: jamais de suppression dure, seulement `active = false`. */
    active: boolean("active").default(true).notNull(),
    createdByAccountId: bigint("created_by_account_id", { mode: "number" }),
    createdAt: createdNow("created_at"),
    updatedByAccountId: bigint("updated_by_account_id", { mode: "number" }),
    updatedAt: createdNow("updated_at"),
    /**
     * ⚠ COLONNE GÉNÉRÉE STORED côté SQL. `generatedAlwaysAs` la marque comme non-insérable pour le
     * query builder; l'expression n'est jamais émise (les migrations sont écrites à la main).
     */
    canonicalDrawable: int("canonical_drawable").generatedAlwaysAs(
      sql`coalesce(male_drawable, female_drawable)`,
      { mode: "stored" },
    ),
  },
  (t) => [
    index("idx_kind_active").on(t.kind, t.active),
    index("idx_canonical").on(t.kind, t.component, t.canonicalDrawable),
  ],
);

/* ══ GRANDCOINS ══════════════════════════════════════════════════════════════
 * La deuxieme face de la boutique : une monnaie achetee sur Tebex et echangee en jeu.
 * Design complet : _server_build/CITADEL_COINS_DESIGN.md.
 *
 * Elle se greffe sur le tuyau VIP existant plutot que d'en ouvrir un second : meme webhook
 * signe, meme file citadel_jobs pour la livraison, meme page /redeem pour le repli par code.
 * Ce qui est neuf, c'est le portefeuille au bout.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * LE PORTEFEUILLE. Une ligne par COMPTE, jamais par personnage.
 *
 * ⚠ La cle est `account_id` et c'est une decision de correction, pas de commodite :
 *  - un mort-RP (gs_identity/server/mortrp.lua) efface le personnage, et il ne doit pas
 *    effacer un solde paye en euros. Le systeme MortRP conserve deja group/bans/warns/gs_logs
 *    pour exactement ce genre de raison ; le portefeuille rejoint cette liste.
 *  - un joueur a plusieurs personnages, et un portefeuille par personnage produit
 *    immediatement le ticket "j'ai achete sur le mauvais perso".
 *  - un remboursement doit pouvoir debiter un solde qui existe encore.
 *
 * ⚠ `balance` n'est PAS la verite, c'est un cache du grand livre ci-dessous. Il est protege
 * par un compare-and-swap sur `version` (meme discipline que gs_bank) : deux clics simultanes,
 * un seul gagne, et `balance >= cost` dans le WHERE rend un solde negatif structurellement
 * impossible plutot que verifie a la main.
 */
export const citadelCoinBalances = mysqlTable(CT.coinBalances, {
  accountId: bigint("account_id", { mode: "number" }).primaryKey(),
  balance: int("balance").default(0).notNull(),
  // Les trois compteurs a vie sont du ressort du PANNEAU, jamais montres au joueur : ils
  // separent ce qui a ete paye de ce qui a ete offert, seule facon de lire honnetement ce que
  // le support a du conceder sur une periode.
  lifetimePurchased: int("lifetime_purchased").default(0).notNull(),
  lifetimeGranted: int("lifetime_granted").default(0).notNull(),
  lifetimeSpent: int("lifetime_spent").default(0).notNull(),
  // Dette laissee par une retro-facturation encaissee APRES depense. Tant qu'elle est > 0, le
  // compte ne peut plus echanger. Politique proprietaire du 2026-08-24 : ni reprise de l'objet
  // deja livre, ni bannissement, un litige de carte n'etant pas toujours une fraude.
  debt: int("debt").default(0).notNull(),
  version: int("version").default(0).notNull(),
  updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
});

/**
 * LE GRAND LIVRE. Append-only, et la seule verite sur un solde.
 *
 * ⚠ `idempotency_key` est UNIQUE, et c'est ce qui ferme avec un seul index deux failles qui
 * n'ont rien a voir l'une avec l'autre : le double-clic d'un joueur sur "Echanger", et la
 * relivraison par Tebex d'un webhook deja traite. Toute ecriture DOIT en fournir une.
 *
 * `balance_after` est un instantane : il permet de lire une ligne sans rejouer tout l'historique,
 * et il rend une divergence entre le cache et le livre visible a l'oeil nu.
 */
export const citadelCoinLedger = mysqlTable(
  CT.coinLedger,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    // Signe : positif = credit, negatif = debit. Jamais un montant absolu accompagne d'un sens.
    delta: int("delta").notNull(),
    balanceAfter: int("balance_after").notNull(),
    reason: mysqlEnum("reason", [
      "tebex",         // achat d'un pack
      "first_bonus",   // bonus de premiere recharge, une seule fois par compte
      "staff_grant",   // geste manuel du staff
      "redeem",        // depense au catalogue (delta negatif)
      "refund",        // livraison echouee, remboursement automatique
      "chargeback",    // retro-facturation (delta negatif, peut creuser une dette)
      "correction",    // ajustement manuel, toujours motive
    ]).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 190 }).notNull().unique(),
    // Pointeur PAR VALEUR vers la ligne d'origine : convention du reste du schema, on ne pose
    // pas de cle etrangere entre les zones citadel_ et jeu.
    refKind: varchar("ref_kind", { length: 32 }),
    refId: varchar("ref_id", { length: 64 }),
    actorAccountId: bigint("actor_account_id", { mode: "number" }), // staff, si geste manuel
    note: varchar("note", { length: 255 }),
    createdAt: createdNow("created_at"),
  },
  (t) => [
    index("idx_coin_ledger_account").on(t.accountId, t.id),
    index("idx_coin_ledger_reason").on(t.reason),
    index("idx_coin_ledger_ref").on(t.refKind, t.refId),
  ],
);

/**
 * LE CATALOGUE, editable depuis le panneau. Aucun prix en dur nulle part ailleurs.
 *
 * `delivery_kind` + `delivery_payload` decrivent CE QUI est livre ; l'executor Lua correspondant
 * revalide integralement la charge utile avant d'agir, donc une ligne mal saisie echoue proprement
 * au lieu de livrer n'importe quoi.
 */
export const citadelCoinCatalog = mysqlTable(
  CT.coinCatalog,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sku: varchar("sku", { length: 64 }).notNull().unique(),
    label: varchar("label", { length: 190 }).notNull(),
    description: varchar("description", { length: 500 }),
    imageUrl: varchar("image_url", { length: 500 }),
    category: mysqlEnum("category", [
      "vehicule", "pack", "vetement", "stockage", "mapping", "service", "vip",
    ]).notNull(),
    costGc: int("cost_gc").notNull(),
    deliveryKind: varchar("delivery_kind", { length: 48 }).notNull(),
    deliveryPayload: json("delivery_payload").notNull(),
    // NULL = illimite. Un entier est un VRAI stock, decremente a chaque echange : la rarete
    // affichee au joueur doit correspondre a quelque chose, sinon c'est une rarete fabriquee.
    stock: int("stock"),
    perAccountLimit: int("per_account_limit"),
    minVipLevel: int("min_vip_level").default(0).notNull(),
    // La rotation de vitrine. Des DATES REELLES : l'article part, le solde reste.
    visibleFrom: nullableDate("visible_from"),
    visibleUntil: nullableDate("visible_until"),
    featured: boolean("featured").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    sortOrder: int("sort_order").default(0).notNull(),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_coin_catalog_visible").on(t.active, t.category, t.sortOrder)],
);

/**
 * UN ECHANGE. Et surtout : le garde-fou d'idempotence de la LIVRAISON.
 *
 * ⚠ Les `coin.deliver.*` ne peuvent pas entrer dans `RetryableKinds` comme les restaurations :
 * une restauration converge vers un ETAT et se rejoue sans consequence, un octroi est un DELTA
 * et se duplique. C'est exactement pourquoi `inventory.refund` est deliberement absent de cette
 * table (voir CITADEL/config.lua). L'idempotence vient d'ici : l'executor relit `status` AVANT
 * d'agir et ne fait rien s'il vaut deja `delivered`, le meme montage que `warrant.create`, qui
 * se dedoublonne lui-meme avant d'ecrire.
 *
 * `catalog_snapshot` n'est pas de la redondance : le catalogue est editable en direct, et sans
 * instantane, changer le prix d'un vehicule reecrirait retroactivement ce que des joueurs ont
 * paye. Meme raisonnement que citadel_vip_entitlements.level, et que tier_snapshot sur les
 * charges du code penal.
 */
export const citadelCoinRedemptions = mysqlTable(
  CT.coinRedemptions,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    // Le PERSONNAGE qui recoit (licence en hexa nu, jointe a users.identifier). Le portefeuille
    // est sur le compte ; la livraison va forcement sur un personnage precis.
    identifier: varchar("identifier", { length: 60 }).notNull(),
    sku: varchar("sku", { length: 64 }).notNull(),
    costGc: int("cost_gc").notNull(),
    catalogSnapshot: json("catalog_snapshot").notNull(),
    status: mysqlEnum("status", ["pending", "delivered", "failed", "refunded"])
      .default("pending")
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 190 }).notNull().unique(),
    jobId: bigint("job_id", { mode: "number" }),
    ledgerDebitId: bigint("ledger_debit_id", { mode: "number" }),
    ledgerRefundId: bigint("ledger_refund_id", { mode: "number" }),
    failureReason: varchar("failure_reason", { length: 255 }),
    createdAt: createdNow("created_at"),
    deliveredAt: nullableDate("delivered_at"),
  },
  (t) => [
    index("idx_coin_redeem_account").on(t.accountId, t.id),
    index("idx_coin_redeem_identifier").on(t.identifier),
    // Le balayeur de remboursement : les echanges restes en attente trop longtemps.
    index("idx_coin_redeem_sweep").on(t.status, t.createdAt),
  ],
);

/**
 * LE REPLI PAR CODE, quand un achat ne se resout ni par telephone ni par Discord.
 * Meme porte joueur que le VIP (/redeem), table separee (charge utile differente).
 */
export const citadelCoinCodes = mysqlTable(
  CT.coinCodes,
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 24 }).notNull().unique(),
    amountGc: int("amount_gc").notNull(),
    status: mysqlEnum("status", ["active", "redeemed", "revoked", "expired"])
      .default("active")
      .notNull(),
    sourceTransactionId: varchar("source_transaction_id", { length: 64 }),
    createdBy: bigint("created_by", { mode: "number" }), // staff, ou NULL si emis par le webhook
    redeemedByAccountId: bigint("redeemed_by_account_id", { mode: "number" }),
    redeemedAt: nullableDate("redeemed_at"),
    expiresAt: nullableDate("expires_at"),
    createdAt: createdNow("created_at"),
    updatedAt: createdNow("updated_at"), // app-maintained on UPDATE
  },
  (t) => [index("idx_coin_code_status").on(t.status)],
);
