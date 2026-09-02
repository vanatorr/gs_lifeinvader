/**
 * THE table-name constants module (CITADEL_DESIGN.md §4).
 * Every table name in the codebase resolves through here - no string literals at call sites.
 *
 * GAME zone - FiveM/ESX owns these. Lua provisions them (CREATE TABLE IF NOT EXISTS at boot).
 * CITADEL introspects and READS; it never migrates or writes them without going through the
 * game bridge or an explicitly documented exception.
 */
export const GAME_TABLES = {
  // ESX core
  users: "users",
  jobs: "jobs",
  jobGrades: "job_grades",
  ownedVehicles: "owned_vehicles",
  /**
   * CE QU'UNE ENTREPRISE A REELLEMENT PAYE POUR UNE VOITURE DE SA FLOTTE, une ligne par plaque.
   *
   * Ecrite par `gs_jobs/modules/vehicleShop/server/main.lua` (`RecordJobVehiclePurchase`) au moment
   * ou un employe achete un modele dans le kiosque, avec le prix que le serveur a reellement debite
   * (`dealerPrice or price` de FleetRoster, resolu serveur, jamais reçu du client).
   *
   * ⚠ C'EST LE COUT REEL, ET IL VAUT MIEUX QUE LE CATALOGUE. Le catalogue dit ce qu'un modele coute
   * AUJOURD'HUI; cette table dit ce que CETTE voiture-la a coute le jour ou elle est entree en
   * flotte. Les deux divergent des qu'un prix bouge, et c'est mesure: une Mesa R figure ici a
   * 275 000 $ (achat ancien) a cote de quatre autres a 70 000 $ (apres l'ajout de son dealerPrice).
   * Calculer un benefice sur le catalogue aurait donc reecrit retroactivement la marge de la
   * premiere.
   */
  jobVehiclePurchases: "job_vehicle_purchases",
  gsMortrp: "gs_mortrp",
  gsMortrpRows: "gs_mortrp_rows",
  userLicenses: "user_licenses",
  // Label catalog for user_licenses.type (gs_utils/server/main.lua LicenseListLookup) - schema's
  // source of truth for the human label of a license type ("drive_bike" -> "Permis moto", etc.).
  licenses: "licenses",
  playerNotes: "player_notes",
  // ESX item catalog (es_extended/server/common.lua ESX.RefreshItems: `SELECT * FROM items`) -
  // name -> label/weight/rare/can_remove. Read-only; resolves a users.inventory JSON key to a real
  // label (verified live 2026-07-16: 622 rows).
  items: "items",
  // Ban backend (gs_weather - the anti-cheat/ban resource despite the name)
  bans: "bans",
  bansIdentifiers: "bans_identifiers",
  anticheatLogs: "anticheat_logs",
  // Anti-cheat DETECTOR CONFIG (gs_utils/modules/anticheat/server/citadel_overrides.lua owns +
  // CREATEs this - a k/v table mirroring staff_config's shape exactly: one 'version' row the game
  // polls, one 'detector.<id>' row per tuned detector holding a JSON patch. CITADEL writes through
  // the citadel_jobs bridge (anticheat.config_set), never directly - see lib/data/anticheatConfig.ts.
  anticheatConfig: "anticheat_config",
  // Attestation ENFORCEMENT switches (gs_weather/server/citadel_overrides.lua owns + CREATEs this,
  // added 2026-07-31) - the four AutoBan booleans under gs_weather's Config.Attestation.Enforcement
  // (TierA/TierB/Honeypot/StructurallySafe). Same k/v/version shape as anticheatConfig above, but a
  // SEPARATE table in a SEPARATE resource: gs_weather is its own Lua VM and owns Config.Attestation,
  // not ConfigAntiCheat, so it cannot share gs_utils' table without a cross-resource write no VM
  // boundary here allows. CITADEL writes through the citadel_jobs bridge (attestation.config_set),
  // never directly - see lib/data/anticheatConfig.ts's ATTESTATION_ENFORCEMENT section.
  attestationConfig: "attestation_config",
  // Staff RBAC (gs_utils/modules/permissions - the single permission authority)
  staffRanks: "staff_ranks",
  staffRankPermissions: "staff_rank_permissions",
  staffPermissionCatalog: "staff_permission_catalog",
  staffConfig: "staff_config",
  staffWarnings: "staff_warnings",
  // Staff DIVISIONS - the second, orthogonal RBAC axis (gs_utils owns + CREATEs these too)
  staffDivisions: "staff_divisions",
  staffDivisionGrants: "staff_division_grants",
  staffDivisionMembers: "staff_division_members",
  // Structured logging (gs_utils/modules/logging)
  gsLogs: "gs_logs",
  gsLogsCategories: "gs_logs_categories",
  gsKvp: "gs_kvp",
  // Society money (esx_addonaccount core, reconstructed in gs_jobs/server/society.lua). READ-ONLY
  // here: gs_jobs owns an in-memory SharedAccounts cache and persists it ABSOLUTELY, so a write from
  // outside that VM is silently reverted by the next in-game deposit. Writes go through the
  // gs_citadel bridge -> gs_jobs exports. See _server_build/CITADEL_FACTIONS.md.
  // gs_inventory's SHARED containers (trunks, bags, lockers, job coffres, properties). NOT a
  // player's carried inventory - that is users.inventory (see lib/data/inventory.ts). Keyed by an
  // opaque STRUCTURED id ("job_job=ballas_name=society_ballas_inventory"), not by a job column.
  gsInventoryStorage: "gs_inventory_storage",
  // APPEND-ONLY archive of every committed container state. gs_inventory's PersistInventory writes
  // the row above AND appends here, on every single mutation (gs_inventory/server/main.lua).
  //
  // ⚠ IT IS THE CONTAINER CHANGE FEED, AND IT WENT UNREAD FOR A MONTH. CITADEL had no way to know a
  // coffre or a trunk had changed - the storage table it reads is an upsert with no cursor - so the
  // container panels were one-shot renders, which is half of the owner's "faction inventory arent
  // live". This table has an auto-increment primary key and one row per mutation, i.e. exactly the
  // monotonic feed ensurePoller walks, and it has been filling since 2026-07-28. No game-side code
  // was needed to make containers live; the signal already existed.
  //
  // ⚠ IT HAS NO RETENTION AND IS THE SECOND-LARGEST TABLE IN THE DATABASE. Measured on production
  // 2026-08-24: 99,518 rows, ~3,700/day, 59 MB. Reading it is cheap (the poller only ever walks the
  // tail); leaving it to grow is not. See scripts/prune-retention.ts.
  gsInventorySnapshots: "gs_inventory_snapshots",
  // gs_bags' instance registry (gs_bags/server/main.lua:184-198). THE durable bag-owner source:
  // storage_id -> owner. Needed because bags became their own entities on 2026-07-17 and a new bag id
  // is `bag_i<N>`, which encodes NO identifier - only this table can attribute one. See lib/data/siem.ts.
  gsBagsInstances: "gs_bags_instances",
  // gs_base/modules/propMenu's placed world objects (CREATE TABLE at that module's
  // server/main.lua:363-379). One row per object a player has planted in the world, INCLUDING the
  // donator-only `category='Stockage'` containers the owner calls "VIP storages". This is the ONLY
  // table that carries a placed container's world position - gs_inventory_storage has no coords.
  // The two are joined by a STRING, never a foreign key: `prop_prop:<gs_props.id>`.
  gsProps: "gs_props",
  // gs_properties. ⚠ job_owned=1 means `owner` holds the JOB NAME, not a license.
  ownedProperties: "owned_properties",
  // Doubles de clés handed out by a property owner (gs_properties/server/main.lua:154-164).
  // ⚠ `property_key` -> owned_properties.id (the COMPOSITE id), and `name` is the KEY's nickname
  // chosen by the giver ("hunter"), NOT the holder's name - that resolves via `identifier` -> users.
  propertySharedKeys: "property_shared_keys",
  addonAccount: "addon_account",
  addonAccountData: "addon_account_data",
  societyTransactions: "society_transactions",
  // gcphone - owns + CREATEs all 11 phone_* tables (server reconstructed 2026-07-16).
  // ⚠ EVERY one of these is keyed by phone NUMBER, never by identifier. The number -> license
  // mapping is `users.phone_number` (gcphone/server/server.lua:12-14,208) - see lib/data/comms.ts.
  // ⚠ NOT declared here: `phone_darkchat` DOES NOT EXIST. DarkChat is RAM-only by owner decision
  // (gcphone/server/tchat.lua:51-54); its only durable record is the gs_logs `phone_darkchat`
  // category. Do not add a table constant for it - there is nothing to point at.
  phoneMessages: "phone_messages",
  phoneCalls: "phone_calls",
  // Per-SIDE call deletion. A player hiding a call must not erase it from the other side's history
  // (gcphone/server/server.lua:467-468), so this is a separate table rather than row ownership.
  phoneCallsHidden: "phone_calls_hidden",
  // Added 2026-07-25 for the Comms tab expansion (plan §2a). ALL SIX are keyed by ESX `identifier`
  // directly (unlike phoneMessages/phoneCalls above, which are keyed by phone NUMBER) - see each
  // table's own comment in schema/game.ts for the source Lua file the shape was verified against.
  phoneContacts: "phone_contacts",
  phoneMarketPlace: "phone_market_place",
  // Bleeter/Onyx accounts are a SEPARATE identity from the ESX character (username+password, not a
  // phone number) - a tweet's author is reached by joining tweets -> accounts, never directly.
  phoneTwitterAccounts: "phone_twitter_accounts",
  phoneTwitterTweets: "phone_twitter_tweets",
  phoneWeazelNews: "phone_weazel_news",
  phoneBankTransactions: "phone_bank_transactions",
  // NOT YET ON DISK as of this change - a parallel game-server track (plan §1b) is adding this table.
  // Declared here against its documented shape (id, identifier, url, time, deleted_at) so the CITADEL
  // side ships ready rather than stubbed; it will simply return no rows until the game side lands.
  phonePhotos: "phone_photos",
  // Justice/warrants/billing, added 2026-07-25 (JUSTICE_CAD_DESIGN_2026-07-25.md §1) - previously
  // absent from this file entirely, so CITADEL could not read any of the three. See each table's
  // own comment in schema/game.ts for the exact Lua source and load-bearing caveats (billing only
  // ever holds UNPAID rows; warrants and police_warrants are sibling rows from one event, not a
  // normalized relation).
  warrants: "warrants",
  policeWarrants: "police_warrants",
  billing: "billing",
  // gs_bank ledger (BANKING_DESIGN_2026-07-25.md), Phase 1. Provisioned and empty of real activity
  // until a caller migrates onto Charge/Credit/Transfer/OfflineApply - see schema/game.ts.
  gsBankAccounts: "gs_bank_accounts",
  gsBankTxn: "gs_bank_txn",
  gsBankEntries: "gs_bank_entries",
  // Weapon serialisation ledger (gs_base/modules/weaponRegistry/server/main.lua CREATEs both).
  // `gs_weapon_registry` is ONE ROW PER WEAPON carrying its CURRENT holder; `gs_weapon_transfers` is
  // the append-only chain of custody. Joined to each other by `serial`, never by id.
  // ⚠ Both are utf8mb4_general_ci (gs_base creates them) while `users` is utf8mb4_unicode_ci, so
  // every join onto a player MUST go through eqCollate() - see lib/db/collation.ts.
  gsWeaponRegistry: "gs_weapon_registry",
  gsWeaponTransfers: "gs_weapon_transfers",
} as const;

/**
 * CITADEL zone - Drizzle migrations manage ONLY these (drizzle.config.ts tablesFilter).
 * Auth.js tables are prefixed: the adapter default `users` collides with ESX `users`.
 */
export const CITADEL_TABLES = {
  // Auth.js (DB sessions - an admin panel needs revocation)
  users: "citadel_users",
  oauthAccounts: "citadel_oauth_accounts",
  sessions: "citadel_sessions",
  verificationTokens: "citadel_verification_tokens",
  /** Short-TTL single-use codes minted in-game - the second path to the same session. */
  authCodes: "citadel_auth_codes",
  // Discord profile cache (snowflake -> @username/display name). Populated by the bot resolving
  // ids and by OAuth login; read by presence enrichment to show @handle for online players.
  discordUsers: "citadel_discord_users",
  // Discord guild registry - AUTO-DISCOVERED by the bot (the guilds it is actually a member of),
  // with `managed` toggled by staff on Page 9. Owner rule: no guild id is ever hardcoded or env'd.
  discordGuilds: "citadel_discord_guilds",
  // Discord sync exemptions - global user skips for the role reconcile engine.
  discordSyncExemptions: "citadel_discord_sync_exemptions",
  // Role cache per guild - lets the mapping editor offer a real picker instead of asking a human
  // to paste snowflakes, and records whether the bot can actually assign each role (hierarchy).
  discordRoles: "citadel_discord_roles",
  // THE mapping: a staff rank -> the Discord role(s) it grants, per guild. CITADEL owns role
  // MEMBERSHIP; the role's own permissions/colour/name stay editable in Discord (owner decision
  // 2026-07-16). A role absent from this table is NEVER touched by the sync engine.
  discordRankRoles: "citadel_discord_rank_roles",
  // Channel cache per guild - same job as discordRoles, for the message composer's channel picker,
  // plus the cached "can the bot actually post/read here" answer so the picker can say so BEFORE
  // someone writes an announcement into a channel the bot is silently unable to speak in.
  discordChannels: "citadel_discord_channels",
  // Composed bot messages (the Discohook-style composer). One row = one message the staff wrote;
  // once sent it carries the Discord message id, which is what makes editing it later possible.
  discordMessages: "citadel_discord_messages",
  // Bot liveness. Page 9 said "statut indisponible" because nothing wrote a status; the bot now
  // beats here so connection state is a real reading rather than an inference from queue activity.
  botHeartbeat: "citadel_bot_heartbeat",
  // ACTUAL Discord role membership, snapshotted by the bot. The missing primitive: without it
  // CITADEL only knows what the mapping INTENDS, never what Discord HOLDS - so it could never
  // answer "who has this role right now", "is anyone holding a role they shouldn't", or show an
  // honest coverage number. Only MANAGED roles are recorded (the engine's blast radius), so this
  // is not a mirror of the guild's member list.
  discordMemberRoles: "citadel_discord_member_roles",
  // LIVE voice occupancy - one row per person currently sitting in a voice channel. A MIRROR of a
  // fact only Discord holds, maintained by the bot's gateway listener, and read by the game to gate
  // the F5 admin menu. Rows are deleted on leave, so "no row" means "not in voice" ONLY when the
  // mirror is fresh - which is the entire reason voiceSync below exists.
  discordVoiceState: "citadel_discord_voice_state",
  // Append-only join/leave history, rendered on the player page. Carries the channel LABEL and a
  // snapshot of who else was in the channel at that moment, because both are unrecoverable later:
  // a channel can be renamed or deleted, and co-occupancy at time T cannot be reconstructed from
  // any other row here.
  discordVoiceEvents: "citadel_discord_voice_events",
  // FRESHNESS CLOCK for the mirror above, one row per guild. Without it a dead bot is
  // indistinguishable from "nobody is in voice": the state table simply stops changing and every
  // reader silently believes a frozen answer. The game treats a stale beat as UNKNOWN, never as
  // absent. See CITADEL/server/voice_gate.lua.
  discordVoiceSync: "citadel_discord_voice_sync",
  // Live session map: which FiveM server-id is which account RIGHT NOW. gs_citadel writes on connect
  // (it has the identifiers) and clears on drop. The reliable server-id -> license/discord source,
  // because players.json identifiers are often empty. Read by presence enrichment.
  online: "citadel_online",
  // LIVE CARRIED BELONGINGS of every currently-connected player - items and weapons, sampled
  // server-side by CITADEL/server/live_belongings.lua. Same inverted ownership as weaponCatalog and
  // cadPresence: CITADEL migrates it, the GAME is its only writer.
  //
  // ⚠⚠ IT EXISTS BECAUSE `users.inventory` IS NOT A LIVE READ, and that is measured, not assumed.
  // ESX flushes that column on a timer and on disconnect, nothing else. On 2026-08-24, of the 39
  // players connected at that moment, the stalest `users` row was 2511 minutes (41.9 h) behind the
  // live xPlayer, with nine over 13 h - so the Inventaire tab was showing a day-old pocket. Fixing
  // the flush cadence (es_extended Config.SaveInterval) shrinks that window but cannot close it: a
  // periodic write is by definition never current. This table is the current one.
  //
  // Money already had this treatment - live_accounts.lua samples balances into citadel_online. It is
  // a SEPARATE table rather than four more columns there because these two blobs are kilobytes, and
  // citadel_online is re-read every few seconds by the presence and map pollers for EVERY player.
  // Widening the hot row to carry payload only one page reads would tax every one of those ticks.
  //
  // Keyed by license, not server_id, so a reconnect lands on the same row. Rows for players who are
  // no longer connected are swept by the writer each tick - an absent row means "not online", which
  // is exactly when the persisted users.inventory is the honest answer.
  onlineBelongings: "citadel_online_belongings",
  // Identity graph
  accounts: "citadel_accounts",
  identifiers: "citadel_identifiers",
  accountLinks: "citadel_account_links",
  linkExemptions: "citadel_link_exemptions",
  // IP intelligence
  ipIntel: "citadel_ip_intel",
  ipExemptions: "citadel_ip_exemptions",
  // Infrastructure
  jobs: "citadel_jobs",
  notifications: "citadel_notifications",
  // Durable cursors for the NOTIFICATION sweeper (lib/notify/sweeper.ts). NOT citadel_config: that
  // is a typed, panel-editable, audited toggle store whose UI lists every row, and a cursor is
  // runtime state, not a setting someone should see or change. Separate table, separate concern.
  notifyCursors: "citadel_notify_cursors",
  // Per-account saved UI layouts. Used by the staff pages to persist card order and keep the same
  // structure when the page is reopened later.
  uiLayouts: "citadel_ui_layouts",
  uploads: "citadel_uploads",
  // Single-use bearer tokens for the game-side (screenshot-basic multipart POST) upload leg. A row
  // here is minted by /api/game/photo-upload-ticket (HMAC-authenticated, server-to-server) and
  // consumed by /api/game/photo-upload (ticket-authenticated, called directly by the game client -
  // it cannot HMAC-sign, since it never constructs the request body itself). See
  // src/lib/data/uploadTickets.ts. Short-lived by design: expiresAt is minutes, not hours.
  uploadTickets: "citadel_upload_tickets",
  // L'ATELIER MIRAGE - la file de dépôt d'assets de jeu (.ytd/.ydd), conception:
  // _server_build/DESIGN_2026-08-24_mirage_asset_portal.md. ⚠ Rien à voir avec `uploads` ci-dessus,
  // qui est le plan de contrôle des IMAGES servies au navigateur depuis R2. Ici les octets ne vont
  // pas dans un bucket: ils doivent atterrir sur le DISQUE de la VM, dans un pack de staging que le
  // propriétaire met en ligne lui-même. Deux audiences, deux cycles de vie, deux tables.
  assetSubmissions: "citadel_asset_submissions",
  assetFiles: "citadel_asset_files",
  // Atelier Forge v2: le registre transactionnel de ce qui a ete ECRIT sur le disque a l'approbation
  // (transaction_id du ChangeSet C#, fichiers touches, etat de rollback), + l'anse de rollback.
  // Conception: _server_build/DESIGN_2026-08-26_atelier_forge_v2.md sections 6.3/9.
  assetApplied: "citadel_asset_applied",
  // Le REGISTRE DES OBJETS GENRES (sacs v1, vetements v1.5): un libelle + le numero de drawable
  // masculin ET feminin par objet, edite depuis l'atelier et relu par gs_bags (motif penalCodeSync)
  // pour regenerer Config.BagGenderMatching + Config.BagsLabel sans redemarrage. Les metadonnees d'item
  // ne sont pas touchees (l'id canonique reste le masculin). Conception:
  // _server_build/DESIGN_2026-08-27_gender_registry.md, migration 0090_gender_registry.sql.
  genderRegistry: "citadel_gender_registry",
  audit: "citadel_audit",
  config: "citadel_config",
  // Reports - the IN-GAME /report queue ONLY. ⚠ A ticket is NOT a report (owner, 2026-07-16):
  // these used to share one table on the theory that both go open->claim->thread->resolve. They
  // don't share a lifecycle, an audience or a page. Discord tickets live in `tickets` below.
  reports: "citadel_reports",
  reportMessages: "citadel_report_messages",
  // TICKETS - the Discord support system (TASEv3 replacement). Discord-DM intake, plus
  // staff-created tickets from the panel (2026-07-17, `origin` column).
  tickets: "citadel_tickets",
  // Staff assignment roster for tickets. Separate from claimedBy so a ticket can have several
  // staff members assigned while still having one primary claim owner.
  ticketStaffAssignments: "citadel_ticket_staff_assignments",
  ticketMessages: "citadel_ticket_messages",
  // WHO is on a ticket. A ticket used to have exactly one player (tickets.opener_discord_id);
  // group tickets made that a set, so the "every recipient is DM-able" invariant moved HERE
  // (participants.discord_id is NOT NULL) and the opener column became mere provenance.
  ticketParticipants: "citadel_ticket_participants",
  // Per-RECIPIENT DM outcome for one message. Fan-out means one message has N independent
  // delivery results (A's DMs are open, B's are closed = 50007), which the old scalar columns
  // on ticket_messages could not express - they were only ever correct because N was always 1.
  ticketDeliveries: "citadel_ticket_deliveries",
  // Per-STAFF read state on a ticket thread - what makes a row bold. Deliberately its own table
  // rather than a column: "has this been read" has a different answer per staff member, and there
  // is no single value citadel_tickets could hold that is true for all of them.
  ticketReads: "citadel_ticket_reads",
  // The bot's persisted conversation state (character picker -> type menu -> open, plus the
  // ticket picker when an inbound DM is ambiguous across several live tickets).
  ticketSessions: "citadel_ticket_sessions",
  // Ticket intake blocklist (snowflake-keyed - an unlinked user has no account). NOT a ban.
  ticketBlocks: "citadel_ticket_blocks",
  // PUBLISHED weapon catalog - the one citadel_* table the GAME writes and CITADEL only reads.
  // It is a published mirror rather than a Lua read (the way vehicleList.lua is read) for one
  // concrete reason: es_extended/config.weapons.lua states every label as `_U('weapon_pistol')`,
  // a LOCALE CALL, so a regex recovers the name and never the human label. See lib/data/weapons.ts.
  weaponCatalog: "citadel_weapon_catalog",
  // PUBLISHED job-storage catalog - every coffre a job DECLARES, whether or not anyone has ever
  // opened it. Same inverted ownership as weaponCatalog: CITADEL migrates, the GAME is the only
  // writer (CITADEL/server/storages.lua).
  //
  // ⚠⚠ IT EXISTS BECAUSE THE COFFRE LIST CANNOT BE ANSWERED FROM THE DATABASE, and that is measured,
  // not assumed. `gs_inventory_storage` only gains a row the first time a real player OPENS a
  // container; on the live DB on 2026-08-15, 154 jobs declared coffres and that table held exactly
  // ONE row of kind='job'. Listing from the game tables therefore shows one coffre and hides 153 -
  // the exact inverse of the owner's "view all of them even if empty".
  //
  // ⚠ AND IT CANNOT BE REGEXED OFF DISK EITHER, for the same reason weaponCatalog cannot: a point's
  // `Name` is frequently an EXPRESSION (`Config.Lspd.Society .. '_safe'`), not a literal, so a static
  // scan can resolve neither the name nor the derived storage id. Only the VM that evaluated those
  // expressions knows. See lib/data/jobStorages.ts.
  jobStorages: "citadel_job_storages",
  // Anti-cheat review (false-positive dismissals - CITADEL-side, no game bridge required)
  anticheatReviews: "citadel_anticheat_reviews",
  // Ban appeals (Page 5 · Bans & Appels) - mirrors the reports shape exactly (submit -> claim ->
  // thread -> decide). CITADEL-owned end to end; the underlying `bans` row stays game-owned.
  banAppeals: "citadel_ban_appeals",
  banAppealMessages: "citadel_ban_appeal_messages",
  // Staff moderation notes (Page 2 · Players - "Modération" tab). NOT the same thing as the game's
  // `player_notes` (GAME_TABLES.playerNotes) - that table is gs_notes' PLAYER-facing personal
  // notepad item (one row per identifier, player-editable). This is a CITADEL-owned, append-only,
  // staff-only annotation feed: many timestamped rows per player, never player-visible.
  playerNotes: "citadel_player_notes",
  // VIP / donator (Tebex -> CITADEL -> game). CITADEL is the SOURCE OF TRUTH for who holds VIP and at
  // what tier; the game only mirrors an integer gs_kvp `donatorLevel` these rows drive. Design:
  // _server_build/CITADEL_VIP.md.
  //  - transactions: append-only ledger of every accepted Tebex webhook. `webhook_id` UNIQUE = the
  //    idempotency guard (Tebex retries failed deliveries; a retry must never double-grant).
  //  - entitlements: one row per granted tier (current + historical). A player's EFFECTIVE
  //    donatorLevel is the MAX(level) over their active, non-expired rows - computed in CITADEL and
  //    pushed as one absolute `player.vip.set` job.
  //  - redeemCodes: the Discord-fallback binding path (a purchase with no resolvable Discord link
  //    issues a code the buyer redeems in the panel to bind the entitlement to their account).
  vipTransactions: "citadel_vip_transactions",
  vipEntitlements: "citadel_vip_entitlements",
  vipRedeemCodes: "citadel_vip_redeem_codes",
  //  - storeCheckouts: the BUYER-IDENTITY side of a purchase, split out from vipTransactions on
  //    purpose. That table is an append-only EVENT ledger keyed on a Tebex webhook id; this one is
  //    PERSONAL DATA (real name, billing address, email, the in-game phone the buyer typed).
  //    Separating them is what makes "who bought this" answerable by a staff member with the right
  //    permission WITHOUT widening access to the whole ledger, and what makes a future
  //    erasure/retention pass a DELETE against one table instead of a surgery on the audit trail.
  storeCheckouts: "citadel_store_checkouts",
  //  - siteRuleSections / siteRuleItems: the PUBLIC reglement (grandside.fr/reglement), owner-editable
  //    from /staff/rules instead of being hand-edited HTML on an FTP server. Two tables rather than
  //    one JSON blob so a rule keeps a stable id: the rules cross-reference each other by number
  //    (`[fair-play](#1.3)`), and those anchors must survive an edit to a neighbouring section.
  siteRuleSections: "citadel_site_rule_sections",
  siteRuleItems: "citadel_site_rule_items",
  //  - manualTabs / manualEntries / manualReads: the INTERNAL moderation manual (/staff/manuel).
  //    Deliberately NOT the same tables as the reglement above, and not a variant of them: the
  //    reglement is public content with one shape (numbered rules), while the manual is staff-only
  //    and every tab has a DIFFERENT shape - a routing table, a sanctions grid, a command list, a
  //    page of prose. Hence `manualTabs.fields`: each tab declares its own columns as JSON and its
  //    entries store values against those keys, so the Fondateur can add a differently-shaped tab
  //    from the panel without a migration. That is the whole point of the feature; a fixed column
  //    set would make "add a tab" an engineering task forever.
  manualTabs: "citadel_manual_tabs",
  manualEntries: "citadel_manual_entries",
  //  - manualReads is a per-STAFF read cursor, not a document property. The manual changes and
  //    staff are expected to re-read it; without a per-person cursor there is no honest way to show
  //    "this tab changed since you last looked", and a shared flag would be cleared by whoever
  //    glances first. Same reasoning as citadel_ticket_reads.
  manualReads: "citadel_manual_reads",
  // Reversible "recycle bin" for placed objects (gs_props). EVERY prop removal snapshots the full
  // gs_props row + the container's contents here before deletion, so a staff member can restore it
  // exactly (same id -> the gs_inventory contents, which survive deletion, reconnect). Written by
  // gs_utils/propMenu (game INSERTs a citadel_* row, like reports); restore enqueues a prop.restore job.
  propDeletions: "citadel_prop_deletions",
  // Staff-only MortRP analyst chat. Persisted separately from the game-owned gs_mortrp ledger so a
  // page refresh never drops the investigation context.
  mortrpMessages: "citadel_mortrp_messages",
  // WHO WAS IN WHICH FACTION, AND WHEN. The game keeps only the CURRENT job (users.job/job2) and
  // overwrites it, so leaving a faction - or being MortRP-wiped, which resets both slots to
  // 'unemployed' - erased the person from that faction's log view entirely. This table is the
  // append-only membership history that makes a faction's log feed survive its people leaving.
  // See lib/data/factionMembership.ts for the model and its honest limits.
  factionMembership: "citadel_faction_membership",

  // ── CAD / MDT (the law-enforcement, fire, and justice workspace at /cad) ──────────────────────
  // Design: fivem/server-data/_server_build/CITADEL_CAD_MDT_PLAN.md.
  //
  // ⚠ cadPresence is the SECOND game-written citadel_* table (the first is weaponCatalog): CITADEL
  // owns and MIGRATES it, but the GAME is its only WRITER - CITADEL/server/cad_presence.lua upserts
  // the duty lease from gs_jobs' authoritative InService state, and CITADEL only READS it as the hard
  // duty gate. Every other CAD table below is CITADEL-owned end to end.
  cadPresence: "citadel_cad_presence",
  cadIncidents: "citadel_cad_incidents",
  cadIncidentEvents: "citadel_cad_incident_events",
  cadIncidentUnits: "citadel_cad_incident_units",
  cadUnitStatus: "citadel_cad_unit_status",
  cadBolos: "citadel_cad_bolos",
  // Dispatch board: callsign GROUPS (Alpha/Bravo/…) and their assigned units - the TASEv3 model.
  cadGroups: "citadel_cad_groups",
  cadGroupMembers: "citadel_cad_group_members",
  // GNR (faction organisation + permissions), per agency, edited by the direction on the "Accès" page.
  // Rang = a grouping of ESX grades; roles = unités/spécialités/habilitations; grants = the ONE matrix
  // that drives CAD (and later in-game/F6/Discord). Design: _server_build/CITADEL_CAD_GNR.md.
  cadRanks: "citadel_cad_ranks",
  cadRankGrades: "citadel_cad_rank_grades",
  cadRoles: "citadel_cad_roles",
  cadMemberRoles: "citadel_cad_member_roles",
  cadGrants: "citadel_cad_grants",
  // MATRICULE - the officer's badge number inside one agency, set by the direction on the "Accès"
  // page. Its own table (not a column on citadel_cad_presence, which is game-written and cleared on
  // off-duty): a matricule belongs to the PERSON and must survive every shift.
  cadMatricules: "citadel_cad_matricules",
  // A CAD rang/rôle linked to a Discord role the bot manages (guild = one of the staff-managed
  // guilds; CAD managers only pick roles, never guilds). Mirrors citadel_discord_rank_roles.
  discordCadRoles: "citadel_discord_cad_roles",
  // The CURRENT reason CITADEL cannot set one member's nickname in one guild. STATE, not history:
  // one row per genuinely broken member, upserted by the bot on every sync and deleted the moment
  // the rename succeeds. It exists so a permanent refusal is readable on the roster forever instead
  // of only inside an 8 second window in one person's browser tab.
  discordNicknameFailures: "citadel_discord_nickname_failures",
  // WHICH DISCORD SERVERS AN AGENCY OWNS, and which of them it actually renames in. Replaces the
  // single citadel_discord_guilds.cad_agency column, which could only ever name ONE agency per
  // server: the owner asked (2026-08-20) for a server to be able to serve several agencies (a shared
  // law-enforcement Discord hosting LSPD and BCSO at once). Two layers in one row - a Fondateur owns
  // the BINDING, the agency's own direction owns the rename tick.
  cadGuilds: "citadel_cad_guilds",

  // Player playtest / bug reports via Discord @mention (bot writes ONLY these; not tickets/reports).
  playtestReports: "citadel_playtest_reports",
  playtestSessions: "citadel_playtest_sessions",

  // ── LIFEINVADER ENTREPRISES (le portail des commerces joueurs, /business) ────────────────────
  // Maquette validée: citadel/design/business-portal-demo.html. Pendant de CITADEL côté JOUEURS:
  // même déploiement Next, hôte distinct, audience différente (un patron de bar n'est pas du staff).
  //
  // businesses  = quels métiers ont le portail activé, et leurs réglages (modules, palette).
  //               Un métier absent d'ici n'a tout simplement pas de portail: l'activation est une
  //               décision explicite, jamais un effet de bord d'un métier existant dans `jobs`.
  // items       = le catalogue vendable, prix client ET part employé, tenu par la direction.
  // sales       = une vente DÉCLARÉE par un employé (le ticket), + ses lignes.
  //               Ce n'est pas de la télémétrie: la vente se joue en RP, le portail l'enregistre.
  // shifts      = les pointages.
  //
  // ⚠ shifts est écrit par le JEU (comme weaponCatalog, cadPresence, serverResources et
  // serverStats): CITADEL le crée et le migre, le jeu en est le seul writer (ouverture sur
  // gs_jobs:serviceChanged, fermeture sur débauche/déconnexion/balayage au boot).
  //
  // ⚠⚠ shifts porte DEUX rôles volontairement confondus, et c'est le point de conception:
  // une ligne ouverte (ended_at IS NULL, heartbeat frais) EST la preuve d'être en service. Le
  // pointage et la porte "en service" sont le MÊME fait, donc une seule table. Les tenir séparés
  // garantirait qu'ils divergent un jour, et un employé serait en service sans pointage ou l'inverse.
  //
  // ⚠⚠ PRÉFIXE `lifeinvader_` ET NON `citadel_` (renommage du 2026-08-14, décision du propriétaire).
  // Ces cinq tables sont les seules du schéma à porter ce préfixe, et ce n'est pas cosmétique: elles
  // appartiennent à un AUTRE produit, servi sur un autre hôte, à une autre audience. Tout le reste
  // du registre (billets, signalements, journal d'audit, Discord, CAD) appartient au panel staff,
  // que le jeu et le bot lisent aussi par leur nom - d'où le refus d'étendre le renommage au-delà.
  //   → Un nom de table se change en DEUX endroits et pas un: ce registre, ET
  //     `ConfigCitadel.Tables.BusinessShifts` (CITADEL/config.lua), parce que le jeu écrit le
  //     pointage sans passer par Drizzle. Les oublier ensemble est impossible; en oublier UN donne
  //     un portail qui lit une table que plus personne n'écrit, sans la moindre erreur nulle part.
  //   → `verify:no-legacy` refuse que les anciens noms réapparaissent.
  businesses: "lifeinvader_businesses",
  businessItems: "lifeinvader_business_items",
  businessSales: "lifeinvader_business_sales",
  businessSaleLines: "lifeinvader_business_sale_lines",
  businessShifts: "lifeinvader_business_shifts",
  /**
   * LE BAREME DE MARGE DES CUSTOMS, et la seule table de ce module que le portail ne peut QUE lire.
   *
   * Regle du proprietaire (2026-08-23): "the margin they should add for themselves on each custom
   * shouldnt be the same per car or per custom on a car. they should be defined by me and not
   * modifiable by them". Elle vit donc HORS de `lifeinvader_businesses`, dont chaque colonne est
   * reecrite par la page Reglages du patron, et derriere son propre code Fondateur
   * (`CODES.BUSINESS_MARGIN`). Aucune Server Action de `/business/` n'y ecrit.
   */
  marginRules: "lifeinvader_margin_rules",
  // ⚠ PAS de table pour les droits, les rayons ni les modèles, et c'est délibéré (2026-08-08,
  //   après un premier jet à 8 tables). Les droits par grade et les rayons du catalogue vivent en
  //   JSON sur la ligne du commerce: ils sont lus EN ENTIER avec lui et réécrits EN ENTIER depuis
  //   les Réglages, jamais interrogés en travers des commerces. Une relation se justifie par les
  //   requêtes qu'elle permet, et celles-là n'existaient pas: la table aurait produit la même
  //   lecture au prix d'une requête de plus sur un résolveur qui tourne à chaque rendu.
  //   Les MODÈLES d'entreprise sont en CODE (lib/business/templates.ts): il y en aura cinq, et
  //   aucune interface ne les édite. Le jour où l'une de ces trois choses aura besoin d'être
  //   interrogée pour elle-même, elle deviendra une table - rien ne l'en empêche, aucune clé
  //   étrangère ne les retient.

  // ── Page 10 · SERVEUR (live console, process control, scheduled reboots) ─────────────────────
  // Design: the /staff/server rebuild contract (Layer 3). CITADEL owns and MIGRATES all four.
  //
  // ⚠ serverResources and serverStats are the THIRD and FOURTH game-written citadel_* tables (after
  // weaponCatalog and cadPresence): CITADEL creates them, the GAME is their only writer
  // (CITADEL/server/servercontrol.lua's heartbeat upserts a full snapshot every tick). CITADEL only
  // READS them - a write from here would be overwritten by the next heartbeat, and worse, would make
  // the panel show a number the game never said.
  serverResources: "citadel_server_resources",
  serverStats: "citadel_server_stats",
  // Scheduled reboots. CITADEL-owned end to end: the reboot scheduler (lib/server/rebootScheduler.ts)
  // is the only writer of last_fired_at / last_warn_*, and the panel is the only writer of the rest.
  serverSchedules: "citadel_server_schedules",
  // Append-only ledger of every start/stop/restart CITADEL asked the launcher for, panel or schedule.
  // The audit row in citadel_audit records the DECISION; this records the OUTCOME (and exists for the
  // schedule path too, which has no human actor and therefore no audit row).
  serverEvents: "citadel_server_events",

  // ── Justice CAD (penal code, casier judiciaire, case layer) ──────────────────────────────────
  // Design: fivem/server-data/_server_build/JUSTICE_CAD_BUILD_SPEC.md §2. Seeded from the owner's
  // spreadsheet (scripts/seed-penal.ts). The case layer has its own root, citadel_justice_cases.
  //
  // 2.1 reference data (seeded; editable in-panel with the `penal.manage` faction capability, DOJ +
  // Bureau du Procureur, or the Fondateur staff code - reinstated 2026-08-21)
  penalTiers: "citadel_penal_tiers",
  penalDomains: "citadel_penal_domains",
  penalCode: "citadel_penal_code",
  penalProcedure: "citadel_penal_procedure",
  penalFootnotes: "citadel_penal_footnotes",
  penalCircumstances: "citadel_penal_circumstances",
  penalFieldGuide: "citadel_penal_field_guide",
  penalRules: "citadel_penal_rules",
  warrantTypes: "citadel_warrant_types",
  procedureDefects: "citadel_procedure_defects",
  procedureConsequences: "citadel_procedure_consequences",
  // Journal des modifications du code penal (2026-08-25). Instantanes AVANT/APRES complets, ce qui
  // le rend annulable depuis le panneau staff - et ce qui tient lieu d'archive : une ligne retiree
  // du code penal est integralement conservee ici, jamais perdue.
  penalRevisions: "citadel_penal_revisions",
  // 2.2 casier judiciaire
  casierEntries: "citadel_casier_entries",
  casierEntryCharges: "citadel_casier_entry_charges",
  casierEntryRevisions: "citadel_casier_entry_revisions",
  casierAttachments: "citadel_casier_attachments",
  // 2.3 justice objects (the case layer).
  //
  // ⚠ THE CASE ROOT MOVED 2026-08-21. Until then a "dossier judiciaire" WAS a row in
  // `citadel_cad_incidents` - the police dispatch call table - and every `case_id` below was an
  // incident id. The owner rejected that coupling ("each cad of each job is supposed to be diff not
  // fully linked"), so the root is now `citadel_justice_cases` with its own timeline
  // (`citadel_justice_case_events`). The two tables were EMPTY at the time of the split (verified by
  // COUNT(*) against the live DB), so this was a schema change, not a data migration - do not treat
  // the absence of a backfill in drizzle/0072 as an oversight.
  justiceCases: "citadel_justice_cases",
  justiceCaseEvents: "citadel_justice_case_events",
  caseParties: "citadel_case_parties",
  caseCharges: "citadel_case_charges",
  caseDecisions: "citadel_case_decisions",
  caseHearings: "citadel_case_hearings",
  caseJudgments: "citadel_case_judgments",
  caseAppeals: "citadel_case_appeals",
  caseDefects: "citadel_case_defects",
  caseExpungements: "citadel_case_expungements",
  accountFreezes: "citadel_account_freezes",
  // CONVOCATIONS (2026-08-22, owner: "allow proc to do convocation too"). A summons is issued to a
  // PERSON, not filed on a case, which is why it is its own table rather than a `citadel_case_hearings`
  // row: a hearing is case-bound (case_id NOT NULL) and sits in a courtroom, while a convocation names
  // a licence, a date and a PLACE THE ISSUER TYPES IN, and may exist with no dossier at all.
  justiceConvocations: "citadel_justice_convocations",
  // The delivery ledger for the Discord notices a convocation sends. Separate table for the same
  // reason citadel_ticket_deliveries is separate from citadel_ticket_messages: one convocation sends
  // SEVERAL notices over its life (the summons, a cancellation, a manual resend) and each has its own
  // outcome. Scalar notify_* columns on the convocation row would let the cancellation's result
  // overwrite the summons's, i.e. quietly lose the record of whether the person was ever told.
  justiceConvocationNotices: "citadel_justice_convocation_notices",

  // Same shape as casierAttachments, sidecar for citadel_account_freezes (§2.3).
  freezeAttachments: "citadel_freeze_attachments",
  // Free-text notes on a person's justice profile (gap closed by W3-SCHEMA against
  // JUSTICE_CAD_BUILD_SPEC.md's person-profile requirement - no table existed for this before).
  // Soft-delete only, same convention as citadel_casier_entries' staff-purge block.
  personNotes: "citadel_person_notes",
  // Portrait/mugshot photos, one row per uploaded or linked image (2026-07-26). Serves TWO surfaces
  // off the same table, distinguished by `slot`: the player-page identity photos (fixed slots
  // front/left/right/back, one CURRENT row per slot, superseded rows kept for history) and the CAD
  // casier mugshot strip (slot 'booking', unlimited, chronological, never superseded). Rows for an
  // UPLOAD source carry uploadId (FK citadel_uploads - stays pending/inert until R2 is configured);
  // rows for a LINK source carry linkUrl directly and need no upload row at all.
  identityPhotos: "citadel_identity_photos",
  // Opaque person/vehicle deep-link refs (JUSTICE_CAD_BUILD_SPEC.md §4.1, owner 2026-07-26): a bare
  // license or a plate must never appear in a URL, so a shareable link carries this instead.
  // Case/hearing/freeze refs reuse each object's own existing public_ref column - this table exists
  // only for person/vehicle. See lib/data/cadRefs.ts.
  cadRefs: "citadel_cad_refs",
  // Forensic watermark marks (2026-07-31, _server_build/CITADEL_LEAK_TRACING.md). One row per staff
  // SESSION, not per account: the row is what turns a recovered mark into a who/when/where, and
  // binding it to the session means a leaked screenshot also pins the login it came from.
  // The mark id is opaque on purpose - the rendered pattern encodes only this key, so reverse
  // engineering the overlay yields a random string and never a staff member's identity.
  watermarkMarks: "citadel_watermark_marks",
  // Every image the leak sweep has looked at, hit or miss (2026-07-31). Storing MISSES is the point:
  // a sweep that has silently stopped receiving attachments (the MessageContent intent got revoked,
  // the bot lost a channel) looks exactly like a sweep finding nothing wrong, and this table is the
  // only thing that can tell those apart. Also the dedupe key, so a reposted image is not rescanned.
  leakScans: "citadel_leak_scans",
  // Discord invite tracking (2026-07-31, owner: "i want to know who invited who"). Two tables and
  // they answer different questions: `discordInvites` is the LIVE mirror of every invite code and
  // its use count (the diff between two snapshots is what identifies which code a joiner used), and
  // `discordInviteJoins` is the durable, append-only attribution ledger. The mirror churns; the
  // ledger is the record and is never rewritten.
  discordInvites: "citadel_discord_invites",
  discordInviteJoins: "citadel_discord_invite_joins",
  // Guild memberships harvested from the `guilds` OAuth scope at login (owner request 2026-07-31).
  // Replaced wholesale per login, since Discord returns the full list and a diff would invent
  // "left this guild" events we cannot actually observe.
  discordUserGuilds: "citadel_discord_user_guilds",
  // One row per (staff member, catalogue entry) they tested from /staff/reference (2026-08-05, owner:
  // "i want it to be each staff can say they tested it. and if it works or not and what are the
  // issues or suggestions"). `entrySlug` keys against the static catalogue in
  // lib/data/implementationCatalog.ts, NOT a foreign key - the catalogue is a text file, not a table,
  // so a renamed "### " heading (which changes its slug) orphans old reports rather than erroring.
  // See catalogTestReports.ts for how a stale slug degrades (the row just never matches any entry).
  catalogTestReports: "citadel_catalog_test_reports",
  // SALONS DE LEAD (2026-08-21, owner: "giving job leads a private channel with them and staff
  // members"). Trois tables, trois roles distincts et non fusionnables:
  //   jobChannels       la LIAISON metier -> salon Discord. Un metier, un salon, jamais deux.
  //   jobChannelGrades  QUELS grades comptent comme lead. Une ligne par rung coche, jamais un
  //                     seuil "grade >= n": la grille LSPD saute de 13 a 15 et un seuil donnerait
  //                     l'acces a des rungs que personne n'a coches.
  //   jobChannelAccess  QUI a l'acces en ce moment, et qui a deja recu le message d'accueil. Le
  //                     registre, pas un cache: sans lui le balayeur ne peut pas distinguer "il
  //                     vient d'etre promu" de "il l'etait deja", donc ne peut ni retirer un acces
  //                     ni eviter de re-pinger tout le monde a chaque tour.
  // QUEL compte Discord est celui d'une personne qui en a plusieurs (12 cas mesures en prod le
  // 2026-08-21). Cle sur le COMPTE et pas sur le personnage: un compte porte parfois plusieurs
  // licences, et deux personnages peuvent partager un compte, donc la question "qui est cette
  // personne sur Discord" ne se pose qu'une fois par compte.
  discordPrimary: "citadel_discord_primary",
  jobChannels: "citadel_job_channels",
  jobChannelGrades: "citadel_job_channel_grades",
  jobChannelAccess: "citadel_job_channel_access",
  // GRANDCOINS (2026-08-24) - la deuxieme face de la boutique. Design:
  // _server_build/CITADEL_COINS_DESIGN.md. Cinq tables, cinq roles distincts:
  //   coinBalances     le portefeuille, UNE ligne par COMPTE (jamais par personnage: un mort-RP
  //                    efface le personnage et ne doit pas effacer un solde achete en euros).
  //                    `balance` n'est qu'un CACHE du grand livre, protege par un compare-and-swap
  //                    sur `version`, exactement comme gs_bank.
  //   coinLedger       le grand livre APPEND-ONLY, la verite. Chaque delta y est ecrit avec une
  //                    `idempotency_key` UNIQUE, ce qui ferme d'un coup le double-clic cote joueur
  //                    ET la relivraison d'un webhook Tebex.
  //   coinCatalog      ce qui est en vente, editable depuis le panneau. Aucun prix en dur ailleurs.
  //   coinRedemptions  un echange. Sert AUSSI de garde-fou d'idempotence a la livraison: l'executor
  //                    relit `status` avant d'agir, ce qui rend `coin.deliver.*` rejouable sans
  //                    dupliquer un vehicule (meme montage que warrant.create).
  //   coinCodes        le repli quand l'acheteur n'est resolu ni par telephone ni par Discord.
  //                    Table SEPAREE de citadel_vip_redeem_codes: meme cycle de vie, charge utile
  //                    differente, et ce depot a deja tranche une fois contre un `kind` fourre-tout
  //                    (cf. tickets vs reports).
  coinBalances: "citadel_coin_balances",
  coinLedger: "citadel_coin_ledger",
  coinCatalog: "citadel_coin_catalog",
  coinRedemptions: "citadel_coin_redemptions",
  coinCodes: "citadel_coin_codes",
} as const;
