# GrandSide.org by Amir Delshadi

Published since we shut down the game mid 2026: FiveM server, pending payments and subscriptions, community Discord, websites, and related services are stopped.

This repo is only a small part of the production stack. Without the unpublished pieces behind [citadel.grandside.org](https://citadel.grandside.org), not everything here will run as expected.

<img width="3072" height="1989" alt="image" src="https://github.com/user-attachments/assets/fc262e43-2b0e-4bbe-8cd7-f22c50e0f2ea" />

---

# LifeInvader Entreprises (contractor slice)

It's a retail portal used by In Game business owners and employees for point of sale, sales, catalog, staff, time tracking.

The LifeInvader pages were super rushed and vibe-coded with Claude and Codex. Only God and those 2 know how this code still works lol.

### Not included

This tree is a **subset** of the production CITADEL monolith. It does **NOT** include:

- Staff panel
- Full staff RBAC (local stub only)
- CAD Panel (Police, Justice Dep, Prosec)
- Discord bot
- AI system
- Game bridge code and HMAC APIs
- ... Almost all the cyber files...

Do not deploy this copy to production. Send patches or PRs back to the owner for merge into `citadel/` on the main repo.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and configure a **dev** Discord OAuth app plus local MariaDB.
3. Import the demo database: `lifeinvader_demo_dump.sql` (15 fake users, real portal businesses/catalogs, remapped sales/shifts). See [`DEMO_ACCOUNTS.md`](./DEMO_ACCOUNTS.md).
4. Point `DATABASE_URL` at that database.
5. `npm run dev`, then open http://localhost:3000/business

You might need to make the bots for oauth yourself unless you comment out the middleware code.

## Verify

```bash
npm run verify:business
```

Needs the demo DB loaded.

## Network admin (Réseau page)

Set your Discord user id in `DEV_NETWORK_ADMIN_DISCORD_IDS` in `.env.local`.
