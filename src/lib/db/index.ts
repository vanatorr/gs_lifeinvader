import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as game from "./schema/game";
import * as citadel from "./schema/citadel";

export const schema = { ...game, ...citadel };

// One pool per process - survive Next.js dev-server HMR without leaking connections.
const globalForDb = globalThis as unknown as { citadelPool?: mysql.Pool };

// Exporté pour les rares chemins qui ont besoin d'une CONNEXION dédiée plutôt que du pool drizzle:
// un verrou d'avis MySQL (GET_LOCK/RELEASE_LOCK) est lié à la session, donc les deux appels doivent
// tomber sur la MÊME connexion, ce que `db.execute` ne garantit pas à travers le pool. Voir
// lib/assets/apply.ts (le verrou single-flight de l'Atelier Forge).
export const pool =
  globalForDb.citadelPool ??
  mysql.createPool({
    uri: process.env.DATABASE_URL,
    connectionLimit: 10,
    // Labels/names are stored as correct utf8mb4; without this the driver negotiates the
    // MariaDB/XAMPP default (cp850) and accented chars come back mangled in the panel.
    // Belt-and-suspenders: also SET NAMES on every fresh connection below - mysql2 has
    // historically ignored `charset` on some pool paths (sidorares/node-mysql2#1325).
    charset: "utf8mb4",
    // MariaDB stores naive local datetimes; keep the driver from re-interpreting them.
    dateStrings: false,
  });

if (!globalForDb.citadelPool) {
  pool.on("connection", (conn) => {
    conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  });
}

if (process.env.NODE_ENV !== "production") globalForDb.citadelPool = pool;

export const db = drizzle(pool, { schema, mode: "default" });
