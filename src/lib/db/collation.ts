/**
 * Cross-zone collation bridge - REQUIRED for any comparison between a game-owned column and
 * either another game-owned column or a citadel_* column. Verified on the live DB 2026-07-16.
 *
 * THE PROBLEM (this is not theoretical - it throws):
 *   MariaDB errors "Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and
 *   (utf8mb4_unicode_ci,IMPLICIT) for operation '='" on column-to-column comparison across
 *   collations. The game's own tables disagree with EACH OTHER:
 *     users.identifier, users.group            -> utf8mb4_unicode_ci   (ESX-created)
 *     staff_ranks.*, staff_rank_permissions.*  -> utf8mb4_general_ci   (gs_utils-created)
 *     gs_logs.source_identifier, actor_rank    -> utf8mb4_general_ci   (gs_utils-created)
 *   So `users.group = staff_ranks.ace_group` (the permission resolution join) and
 *   `gs_logs.source_identifier = users.identifier` (the log viewer's player join) BOTH throw.
 *
 * WHY THE GAME NEVER HITS IT: Lua does two separate queries with the identifier as a bound
 * PARAMETER. A parameter is a literal and gets coerced to the column's collation, so no mix
 * occurs. CITADEL wants real JOINs (N+1 per log row is not an option on a live table), so it
 * must state the collation explicitly.
 *
 * WHY NOT JUST ALTER THE TABLES: the game zone (gs_ / ESX) is FiveM-owned (CITADEL_DESIGN.md §4).
 * Lua provisions it via CREATE TABLE IF NOT EXISTS and would not re-apply our change; altering
 * it is exactly the "two owners, one schema" fight the ownership split exists to prevent.
 *
 * SAFETY: every value compared through here is ASCII (hex licenses, group names, dot-notation
 * permission codes), where general_ci and unicode_ci order and compare identically. The COLLATE
 * choice is therefore semantically inert - it only resolves the type error.
 *
 * ⚠ INDEX COST: forcing a collation on the INDEXED side of a comparison prevents index use.
 * Always apply COLLATE to the OTHER side, or to a literal. `joinCollate` below is written so the
 * clause attaches to the expression, letting the target column keep its index.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";

/** The collation every cross-zone comparison is normalized to. */
export const BRIDGE_COLLATION = "utf8mb4_general_ci";

/**
 * Compare two columns that may live in different collations.
 * Emits: `a = b COLLATE utf8mb4_general_ci`
 *
 * Pass the column whose index you want PRESERVED as `indexed` - the COLLATE lands on `other`.
 */
export function eqCollate(indexed: AnyMySqlColumn, other: AnyMySqlColumn): SQL {
  return sql`${indexed} = ${other} COLLATE ${sql.raw(BRIDGE_COLLATION)}`;
}

/**
 * Compare an indexed game column against a SQL EXPRESSION whose operands live in another collation
 * - e.g. `addon_account_data.account_name = CONCAT('society_', jobs.name)`, where the left side is
 * utf8mb4_general_ci (gs_jobs/esx_addonaccount) and jobs.name is utf8mb4_unicode_ci (ESX).
 *
 * WHY THIS EXISTS SEPARATELY FROM eqCollate: eqCollate takes two COLUMNS. The society-balance join
 * has no second column to hand it - the right side is built with CONCAT. Verified live 2026-07-16:
 * without the COLLATE, MariaDB throws ERROR 1267 at RUNTIME (it type-checks nothing at build time,
 * so this surfaces as a 500 on the page, not a failed compile).
 *
 * COLLATE lands on the EXPRESSION, so `indexed` keeps its index - same discipline as eqCollate.
 */
export function eqCollateExpr(indexed: AnyMySqlColumn, expr: SQL): SQL {
  return sql`${indexed} = (${expr}) COLLATE ${sql.raw(BRIDGE_COLLATION)}`;
}

/**
 * Compare a game column against a bound value. Parameters coerce automatically, so this needs
 * no COLLATE - it exists so call sites don't have to reason about which case they're in.
 */
export function eqValue(column: AnyMySqlColumn, value: string): SQL {
  return sql`${column} = ${value}`;
}
