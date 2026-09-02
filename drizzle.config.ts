import { defineConfig } from "drizzle-kit";

/**
 * Migrations manage ONLY citadel_* tables (CITADEL_DESIGN.md §4).
 * Game tables (gs_ / ESX / staff_) are FiveM-owned: introspected read-only into src/lib/db/schema/game.ts,
 * never created, altered, or dropped from here. The tablesFilter is the guard rail that keeps
 * drizzle-kit from ever proposing changes to game tables.
 */
export default defineConfig({
  dialect: "mysql",
  schema: "./src/lib/db/schema/citadel.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  tablesFilter: ["citadel_*"],
});
