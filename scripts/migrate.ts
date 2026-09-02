/**
 * Apply pending citadel_* migrations.
 *
 * Use this rather than `drizzle-kit migrate`: that CLI hangs indefinitely against this MariaDB
 * (prints "applying migrations..." forever, applies nothing, exits 0 - a silent no-op that reads
 * like success). The programmatic migrator works and surfaces real errors, so it is the supported
 * path. `drizzle-kit generate` is still the right way to CREATE a migration.
 *
 * Only touches citadel_ tables - the game zone (gs_ / ESX) is FiveM-owned (CITADEL_DESIGN.md §4).
 */
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { findLegacyTables } from "./verify-no-legacy-tables";

export async function applyCitadelMigrations() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing (citadel/.env.local)");

  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    await migrate(drizzle(conn), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied (citadel_ tables only)");
  } finally {
    await conn.end();
  }
}

async function main() {
  await applyCitadelMigrations();

  // Advisory only (read-only). Surface orphaned old-brand (bay_*) tables if any linger. CITADEL does
  // not own or drop the game zone, so this WARNS rather than fails or cleans - the FiveM side
  // (gs_utils/modules/dbHygiene) sweeps them at boot. See scripts/verify-no-legacy-tables.ts.
  try {
    const legacy = await findLegacyTables();
    if (legacy.length > 0) {
      console.warn(
        `WARNING: ${legacy.length} legacy (bay_*) table(s) present: ${legacy.join(", ")}. ` +
          `These are game-zone residue CITADEL does not own. Resolve on the FiveM side ` +
          `(server console \`gs_db_hygiene\`) or run \`npm run verify:no-legacy\` for detail.`,
      );
    }
  } catch (e) {
    console.warn(`(legacy-table check skipped: ${e instanceof Error ? e.message : String(e)})`);
  }
}

if (process.argv[1] && /[\\/]scripts[\\/]migrate\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`Migration failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
