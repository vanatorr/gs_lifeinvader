/**
 * MySQL 1062 ("Duplicate entry ... for key ..."), WHEREVER DRIZZLE HAS BURIED IT.
 *
 * ⚠ THE OBVIOUS `err.code === "ER_DUP_ENTRY"` IS ALWAYS FALSE HERE, and so is a regex over the
 * top-level `message`. Drizzle wraps every driver error in a `DrizzleQueryError` whose own message is
 * "Failed query: insert into ..." and which carries NO `code` and NO `errno`. The real mysql2 error,
 * the one with `code: 'ER_DUP_ENTRY'` and `errno: 1062`, sits on `.cause`.
 *
 * WHY THIS FILE EXISTS RATHER THAN NINE LOCAL COPIES. The naive predicate shipped seven times in this
 * codebase before anyone saw it (`lib/data/cad.ts`, `cadRefs.ts`, `desks.ts`, `vip.ts`, `tickets.ts`,
 * `casier.ts`, `freezes.ts`), because it does not fail like a bug fails. A generate-and-retry loop
 * whose predicate never fires simply rethrows on the first collision: the retry it exists to perform
 * never happens, and the damage is exactly as rare as the collision, so nothing ever points at it. The
 * officer sees a generic "Action refusée" for a 1-in-a-million ref clash; a double-clicked sale
 * rethrows a raw driver error at someone whose sale had in fact just gone through. None of it was
 * visible to review or to the typecheck. Both times it WAS caught, it was caught the same way: by
 * exercising a real duplicate against a real database (`scripts/verify-dupkey-retry.ts`,
 * `scripts/verify-business.ts`).
 *
 * So there is exactly one implementation, and it walks the cause chain. Depth-capped and
 * cycle-guarded: `cause` carries no attacker input, but a self-referential or absurdly nested chain
 * must not spin.
 */

/** Deep enough for driver -> drizzle -> any future re-wrap, shallow enough to stay a constant. */
const MAX_CAUSE_DEPTH = 8;

type ErrorLike = {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  sqlMessage?: unknown;
  cause?: unknown;
};

/** Every link of the `.cause` chain, nearest first. Never throws, whatever it is handed. */
function causeChain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && (typeof cur === "object" || typeof cur === "function") && out.length < MAX_CAUSE_DEPTH) {
    if (seen.has(cur)) break;
    seen.add(cur);
    out.push(cur as ErrorLike);
    cur = (cur as ErrorLike).cause;
  }
  return out;
}

/** mysql2 puts the human text on `message`; some paths fill only `sqlMessage`. Read both. */
function textOf(e: ErrorLike): string {
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.sqlMessage === "string") parts.push(e.sqlMessage);
  return parts.join("\n");
}

/**
 * Did this write hit a UNIQUE index, on any key?
 *
 * The right predicate for a loop that owns every unique on the table it writes (a generate-and-retry
 * over a random `public_ref`, a mint-or-reuse that re-reads afterwards). Where a table can grow a
 * SECOND unique whose violation would be a real bug rather than a retryable clash, use
 * `isDuplicateKeyOn` instead and name the index.
 *
 * `/duplicate entry/i` and not `/duplicate/i`: the wrapper's message embeds the whole SQL statement,
 * so the looser regex matches any query that merely contains the word. The code/errno tests carry the
 * real load anyway; the text test is only a fallback for a driver path that fills neither.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return causeChain(err).some(
    (e) => e.code === "ER_DUP_ENTRY" || e.errno === 1062 || /duplicate entry/i.test(textOf(e)),
  );
}

/**
 * Did this write hit ONE NAMED unique index?
 *
 * Narrow on both axes on purpose (the rule `lib/data/tickets.ts` set and this preserves): 1062 alone
 * is not enough when a table can grow other uniques, because retrying one of those papers over a real
 * bug by minting a fresh ref and inserting anyway.
 *
 * ⚠ The index name lives on the DRIVER error, never on the drizzle wrapper (whose message is the SQL
 * text, which does not name indexes), so this has to scan the whole chain too, not just the error it
 * was handed. MySQL 8 reports `for key 'table.index'` and MariaDB `for key 'index'`; a substring test
 * matches both.
 */
export function isDuplicateKeyOn(err: unknown, indexName: string): boolean {
  if (!isDuplicateKeyError(err)) return false;
  return causeChain(err).some((e) => textOf(e).includes(indexName));
}
