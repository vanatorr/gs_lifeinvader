import { customType } from "drizzle-orm/mysql-core";

/**
 * A DATETIME that round-trips correctly against THIS database. Use it for every datetime column -
 * game-owned or citadel-owned. Verified against the live DB 2026-07-16.
 *
 * THE BUG IT FIXES (silent, and it corrupts both reads and comparisons):
 *   MariaDB DATETIME is a naive wall-clock with no zone. Everything already in this database was
 *   written by MariaDB's own CURRENT_TIMESTAMP, which is the SERVER'S LOCAL TIME (America/Toronto).
 *   `gs_logs.created_at`, `bans.date`, and the citadel_* defaults are all naive-LOCAL.
 *
 *   Drizzle's stock `datetime({ mode: "date" })` parses that naive string as **UTC**. On this box
 *   (EDT, UTC-4) every value therefore comes back FOUR HOURS OFF, and every Date written goes in
 *   four hours off in the other direction. Observed directly:
 *       stored:            2026-07-16 02:05:45   (naive local = 06:05:45Z)
 *       drizzle read:      2026-07-16T02:05:45Z  (wrong by the UTC offset)
 *   Consequences: the logs page renders every timestamp 4h wrong, and
 *   `gt(expiresAt, new Date())` compares 02:05:45Z > 06:03:45Z and is ALWAYS false - which made
 *   every in-game auth code unredeemable. Caught by scripts/verify-ingame-auth.ts, not by types:
 *   both sides are `Date`, so TypeScript is perfectly happy while the value is wrong.
 *
 * WHY NOT "just store UTC": the game owns most of these columns and writes them with
 * CURRENT_TIMESTAMP from Lua. We cannot make FiveM write UTC without touching the game's zone
 * handling server-wide, and a half-converted database is worse than a consistent local one. So
 * CITADEL matches the database that already exists rather than fighting it.
 *
 * DST is handled for free: the Date constructor and getters below use the platform's local zone, so
 * a value stored in EST reads back as EST and one stored in EDT reads back as EDT. This is only
 * correct while the Node process and MariaDB share a timezone - they do (same box), and that
 * assumption is asserted by scripts/verify-time.ts.
 */
export const localDatetime = customType<{
  data: Date;
  // `mode` is accepted for drop-in parity with drizzle's stock datetime() call sites; this type is
  // always Date-mode, so it is intentionally ignored rather than silently half-honoured.
  config: { fsp?: number; mode?: "date" | "string" };
  driverData: string | Date;
}>({
  dataType() {
    return "datetime";
  },

  fromDriver(value: string | Date): Date {
    // mysql2 may hand back either a pre-parsed Date (already local-correct) or the raw string,
    // depending on driver config. Accept both rather than depending on which.
    if (value instanceof Date) return value;
    return parseNaiveLocal(value);
  },

  toDriver(value: Date): string {
    return formatNaiveLocal(value);
  },
});

/**
 * Coerce a datetime that did NOT come through a typed column back into a real local Date.
 *
 * ⚠ WHY YOU NEED THIS, AND WHEN. `localDatetime` above only runs its `fromDriver` for a COLUMN.
 * A raw SQL expression - `sql<Date>\`MAX(${table.createdAt})\`` - has NO mapper, so drizzle hands the
 * driver's value straight through while `sql<Date>` ASSERTS to TypeScript that it is a Date. It is
 * not: it arrives as the naive-local STRING "2026-07-16 21:19:36". Nothing catches this - tsc is
 * satisfied by the assertion, and it only explodes at runtime on the first `.getTime()`/`.toLocale*`.
 * (Verified 2026-07-17: a MAX() over society_transactions.created_at came back `typeof === "string"`.)
 *
 * So: any aggregate/expression that yields a datetime MUST be typed `sql<string | Date>` and passed
 * through here. Do NOT re-implement the parse at the call site - that is exactly how the four-hour
 * offset documented above gets reintroduced, one copy at a time.
 */
export function toLocalDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return parseNaiveLocal(value);
}

/** "2026-07-16 02:05:45" -> a Date at 02:05:45 LOCAL (not UTC). */
function parseNaiveLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return new Date(s); // unexpected shape - don't silently produce Invalid Date
  const [, y, mo, d, h, mi, sec] = m;
  // The multi-arg Date constructor interprets its arguments in LOCAL time. That is the whole fix.
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
}

/** A Date -> "YYYY-MM-DD HH:MM:SS" in LOCAL wall-clock, matching what MariaDB stores. */
function formatNaiveLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * A JSON column that is actually an OBJECT when you read it back.
 *
 * THE BUG IT FIXES (silent, and TypeScript actively hides it):
 *   MariaDB implements JSON as LONGTEXT and does not flag it as JSON on the wire, so mysql2 hands
 *   the column back as a RAW STRING and drizzle's stock `json()` does not parse it on read. The
 *   column is declared `.$type<Foo[]>()`, so tsc believes it is `Foo[]` and every `.map`, `.some`
 *   or property access compiles - then throws `x.some is not a function` at runtime, or worse,
 *   quietly yields `undefined` and the feature degrades instead of failing.
 *
 *   Observed directly on this database 2026-08-08:
 *       written:  [{ key: "a", label: "A", tone: 1 }]
 *       read:     '[{"key":"a","label":"A","tone":1}]'   (typeof "string")
 *
 *   The near miss that made this worth a custom type rather than a helper: with a grants object read
 *   back as a string, `grants[String(grade)] ?? []` yields `[]` rather than throwing, so EVERY
 *   non-boss employee silently holds zero capabilities the moment a boss configures anything. Fails
 *   closed, therefore invisible, therefore shipped.
 *
 * WHY A COLUMN TYPE AND NOT A `coerceJson()` AT THE CALL SITE: the codebase already has that helper
 * twice (lib/data/discordMessages.ts and bot/worker.ts, both with the same explanation attached),
 * which is the shape of a rule that every new reader has to be told about and one of them eventually
 * will not be. Parsing in `fromDriver` makes forgetting impossible: there is no read path that
 * bypasses it. Existing `json()` columns are deliberately left alone here - migrating them is its
 * own change, and their current call sites already coerce.
 *
 * Fails SOFT on malformed stored text (returns null rather than throwing), for the same reason
 * discordMessages does: an old row written before a shape change must stay readable, and a page that
 * throws on one bad row shows nothing at all instead of showing the other rows.
 */
export const parsedJson = <T>() =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return "json";
    },
    fromDriver(value: unknown): T {
      // mysql2 hands back a string on MariaDB, but a real MySQL server (or a driver upgrade that
      // starts flagging the column) would hand back a parsed value. Accept both rather than
      // depending on which - the same defensiveness localDatetime applies just above.
      if (typeof value !== "string") return value as T;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null as T;
      }
    },
    toDriver(value: T): string {
      return JSON.stringify(value);
    },
  });
