/**
 * Repair double-encoded / FixMojibake-corrupted French text for display.
 *
 * TWO bugs this undoes (idempotent on clean UTF-8):
 *
 * 1. Classic mojibake: UTF-8 bytes were read as latin1/CP1252 and re-saved as UTF-8
 *    ("TÃ©lÃ©phone" → "Téléphone"). Common when a client negotiated the wrong charset.
 *
 * 2. FixMojibakeText Lua bug (es_extended/server/common.lua, fixed 2026-07-20): a
 *    `string.gsub` key used ASCII "-" as a Lua pattern quantifier, so every UTF-8 lead
 *    byte 0xC3 became "Ö" and the continuation byte was left orphaned. After a later
 *    latin1→utf8 pass that orphan became U+0096 + (©/¯/…). Observed in gs_logs:
 *    "TÖlÖphone" bytes C3 96 C2 96 C2 A9 for what should be "Téléphone".
 *
 * Apply at every CITADEL read of game-originated prose (logs, stamped inventory labels,
 * job/item catalog fallbacks). Do NOT use this to "fix" identifiers, plates, or hashes.
 */
export function fixMojibake(input: string | null | undefined): string {
  if (input == null || input === "") return input ?? "";
  let text = input;

  // Pass 1: FixMojibake artifact Ö + U+0096 + latin1-byte-as-char → original C3 xx char.
  // U+00D6 = Ö, U+0096 = the re-encoded orphaned 0x96 that sat next to the Ö replacement,
  // third char's codepoint is the original continuation byte (0xA9 for é, 0xAF for ï, …).
  text = text.replace(/\u00D6\u0096([\u0080-\u00FF])/g, (_m, c: string) => {
    const second = c.charCodeAt(0) & 0xff;
    try {
      return Buffer.from([0xc3, second]).toString("utf8");
    } catch {
      return _m;
    }
  });

  // Pass 1b: Ö + U+FFFD (orphan replaced with replacement char) - second byte is lost.
  // Best effort: Ö alone in French item context is almost always a mangled é/è/à/…;
  // we cannot recover which, so strip the FFFD and leave Ö rather than invent a letter.
  text = text.replace(/\u00D6\uFFFD/g, "Ö");

  // Pass 2: classic double-UTF-8. Only rewrite when the latin1 round-trip actually
  // reduces Ã/Â markers - never touch clean French ("été" must stay "été").
  if (text.includes("Ã") || text.includes("Â") || text.includes("â€")) {
    text = repairClassicMojibake(text);
  }

  return text;
}

function repairClassicMojibake(text: string): string {
  // Whole-string round-trip only when every char is latin1-representable. Otherwise
  // walk marker clusters (same approach as the source-file repair).
  const allLatin1 = [...text].every((ch) => ch.charCodeAt(0) <= 0xff);
  if (allLatin1) {
    try {
      const repaired = Buffer.from(text, "latin1").toString("utf8");
      if (scoreMojibake(repaired) < scoreMojibake(text)) return repaired;
    } catch {
      /* fall through to cluster walk */
    }
  }

  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const isMarker =
      ch === "Ã" || ch === "Â" || (ch === "â" && text[i + 1] === "€");
    if (!isMarker) {
      out += ch;
      i += 1;
      continue;
    }
    let accepted: string | null = null;
    let consumed = 1;
    const max = Math.min(text.length, i + 80);
    for (let end = max; end > i; end--) {
      const chunk = text.slice(i, end);
      if (![...chunk].every((c) => c.charCodeAt(0) <= 0xff)) continue;
      if (!chunk.includes("Ã") && !chunk.includes("Â") && !chunk.includes("â€")) continue;
      try {
        const repaired = Buffer.from(chunk, "latin1").toString("utf8");
        if (scoreMojibake(repaired) < scoreMojibake(chunk)) {
          accepted = repaired;
          consumed = end - i;
          break;
        }
      } catch {
        /* try shorter */
      }
    }
    if (accepted != null) {
      out += accepted;
      i += consumed;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function scoreMojibake(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "Ã" || c === "Â") n += 2;
    if (c === "â" && s[i + 1] === "€") n += 2;
    if (c === "\uFFFD") n += 3;
  }
  return n;
}

/** Nullable-friendly wrapper for optional DB columns. */
export function fixMojibakeNullable(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  return fixMojibake(input);
}
