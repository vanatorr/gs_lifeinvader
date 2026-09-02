/**
 * FiveM gs_website tablet embed: CSP frame-ancestors + path allowlist.
 *
 * The CEF parent is NOT a normal https origin:
 *   - fx_version bodacious (gs_website today): ancestor scheme is `nui:`
 *   - fx_version cerulean: ancestor is `https://cfx-nui-<resource>` but Chromium rejects hostnames
 *     with underscores in frame-ancestors (e.g. gs_website). Bodacious needs only `nui:`.
 *
 * `frame-ancestors *` does NOT allow `nui://` (Chrome treats * as network schemes only).
 * Omitting frame-ancestors entirely allows ANY site to iframe these pages (clickjacking).
 * This module allowlists only FiveM NUI parents + local dev CEF.
 */

/** Paths the in-game tablet iframe may load (auth redeem chain + CAD shell). */
export const INGAME_EMBED_PATH_PREFIXES = [
  "/auth/ingame",
  "/login",
  "/cad",
  "/profile",
] as const;

export function isIngameEmbedPath(pathname: string): boolean {
  if (pathname === "/") return true;
  for (const prefix of INGAME_EMBED_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/** Next.js headers() `source` entries kept in sync with {@link isIngameEmbedPath}. */
export const INGAME_EMBED_HEADER_SOURCES = [
  "/",
  "/auth/ingame",
  "/login",
  "/cad",
  "/cad/:path*",
  "/profile",
  "/profile/:path*",
] as const;

/** Cerulean NUI origin only when the resource name is a valid CSP host (no underscores). */
export function ceruleanCfxNuiAncestor(resourceName: string): string | null {
  const name = resourceName.trim();
  if (!name || !/^[a-z0-9-]+$/i.test(name)) return null;
  return `https://cfx-nui-${name}`;
}

const DEV_FRAME_ANCESTORS = [
  "http://127.0.0.1:*",
  "https://127.0.0.1:*",
  "http://localhost:*",
  "https://localhost:*",
] as const;

const scriptSrc =
  process.env.NODE_ENV === "production"
    ? "script-src 'self' 'unsafe-inline';"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval';";

function parseCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSpaceList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Build the `frame-ancestors` source list (space-separated, no directive name). */
export function buildFrameAncestorSources(): string[] {
  const resources = parseCsv(process.env.CITADEL_INGAME_NUI_RESOURCES);

  const ceruleanAncestors = resources
    .map(ceruleanCfxNuiAncestor)
    .filter((s): s is string => s !== null);

  /**
   * ⚠ `DEV_FRAME_ANCESTORS` PARTAIT EN PRODUCTION, ET CE FICHIER SAVAIT DEJA QU'IL NE FALLAIT PAS.
   *
   * `scriptSrc`, quinze lignes plus haut, teste `NODE_ENV` pour ne pas laisser `'unsafe-eval'`
   * atteindre la prod. La liste ci-dessous, elle, ne le testait pas: `http://localhost:*` et
   * `http://127.0.0.1:*` etaient donc des ancetres autorises SUR LA PRODUCTION. N'importe quel
   * programme capable d'ouvrir un port sur la machine d'un agent pouvait encadrer `/cad`, c'est a
   * dire la plus grosse surface d'ECRITURE de l'application (code penal, dossiers, mandats, gels),
   * et lui superposer un leurre. Le cookie de session in-game etant `SameSite=None`, le cadre est
   * authentifie: le clic compte vraiment.
   */
  const sources: string[] = [
    "nui:",
    "https://nui-game-internal",
    ...ceruleanAncestors,
    ...(process.env.NODE_ENV === "production" ? [] : DEV_FRAME_ANCESTORS),
    ...parseSpaceList(process.env.CITADEL_INGAME_FRAME_ANCESTORS_EXTRA),
  ];

  // De-dupe while preserving order.
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export function frameAncestorsCspValue(): string {
  return `frame-ancestors ${buildFrameAncestorSources().join(" ")}`;
}

export const baseSecurityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
  },
  {
    key: "X-DNS-Prefetch-Control",
    value: "off",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
] as const;

/**
 * La politique, moins la regle d'encadrement, qui est la SEULE partie qui varie.
 *
 * Les deux politiques se construisent a partir de ces memes morceaux pour qu'elles ne puissent pas
 * diverger: avant, la chaine complete etait ecrite deux fois, et une correction appliquee a l'une
 * (par exemple `worker-src`) pouvait rester absente de l'autre sans que rien ne le signale.
 */
const CSP_HEAD = `default-src 'self'; base-uri 'self'; form-action 'self'`;
const CSP_TAIL = `object-src 'none'; img-src 'self' data: blob: https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scriptSrc} connect-src 'self' https: wss:; media-src 'self' https: blob:; worker-src 'self' blob:`;

/** Embeddable policy: allowlisted NUI ancestors, and never X-Frame-Options (it has no allowlist). */
export function ingameEmbedCspValue(): string {
  return `${CSP_HEAD}; ${frameAncestorsCspValue()}; ${CSP_TAIL}`;
}

/** Locked policy: same rules, but only this origin may frame the page. */
export function lockedCspValue(): string {
  return `${CSP_HEAD}; frame-ancestors 'self'; ${CSP_TAIL}`;
}

/** Applied on in-game embed routes: allowlisted ancestors, never X-Frame-Options. */
export function ingameEmbedHeaderEntries(): { key: string; value: string }[] {
  return [
    ...baseSecurityHeaders,
    {
      key: "Content-Security-Policy",
      value: ingameEmbedCspValue(),
    },
  ];
}

/** Default lock for staff panel and everything else not explicitly embeddable. */
export const staffLockedHeaderEntries = [
  ...baseSecurityHeaders,
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Content-Security-Policy",
    value: lockedCspValue(),
  },
] as const;

/**
 * ⚠⚠ LA POLITIQUE D'ENCADREMENT SE DECIDE ICI, ET NULLE PART AILLEURS.
 *
 * `next.config.ts` ne peut pas la decider seul, pour deux raisons mesurees sur la prod du
 * 2026-08-26, chacune invisible depuis le fichier de config:
 *
 * 1. `headers()` est une LISTE BLANCHE de chemins (`/staff`, `/business`). Tout ce qui n'y figure
 *    pas ne recoit NI CSP NI X-Frame-Options: `/atelier` et `/redeem` repondaient sans aucune
 *    protection d'encadrement. Une liste blanche se perime a la premiere route ajoutee, et l'echec
 *    est silencieux: la page s'affiche parfaitement, elle est seulement encadrable.
 *
 * 2. `headers()` compare le chemin AVANT reecriture. Sur la marque joueur
 *    (lifeinvader.grandside.org) le chemin demande est `/reseau`, `/caisse`, jamais `/business/...`,
 *    donc la regle `/business/:path*` ne s'y applique PAS. Mesure: `/reseau` sur cet hote repondait
 *    sans CSP ni XFO, et `/` y recevait la politique PERMISSIVE des routes encadrables en jeu. La
 *    correction de `next.config.ts` (bloc `/business`) ne protegeait donc que l'URL de la marque
 *    staff, pas l'hote que les joueurs utilisent reellement, alors que c'est une surface d'ECRITURE
 *    (declarer une vente, corriger un pointage).
 *
 * Le middleware, lui, voit l'HOTE et le chemin D'ORIGINE. C'est le seul endroit qui dispose des deux,
 * donc c'est le seul endroit ou la decision peut etre juste. Le defaut y est FERME: on verrouille, et
 * seules les routes explicitement encadrables en jeu obtiennent la politique permissive.
 *
 * ⚠ L'hote joueur n'est JAMAIS encadrable: le lien du tablet est bati sur `citadel_front_addr`
 * (CITADEL/server/auth.lua), qui pointe sur l'hote staff. Sans cette condition, `/` sur la marque
 * joueur retombe dans `isIngameEmbedPath` (qui accepte `/`) et rouvre exactement le trou ci-dessus.
 */
export function frameHeadersFor(opts: {
  pathname: string;
  businessHost: boolean;
}): { csp: string; xFrameOptions: string | null } {
  const embeddable = !opts.businessHost && isIngameEmbedPath(opts.pathname);
  return embeddable
    ? { csp: ingameEmbedCspValue(), xFrameOptions: null }
    : { csp: lockedCspValue(), xFrameOptions: "SAMEORIGIN" };
}

export type EmbedHeaderCheckResult = {
  ok: boolean;
  path: string;
  xFrameOptions: string | null;
  csp: string | null;
  frameAncestors: string | null;
  errors: string[];
};

/** Used by verify:ingame-embed against a running Next server. */
export function verifyEmbedResponseHeaders(
  path: string,
  headers: Headers,
): EmbedHeaderCheckResult {
  const errors: string[] = [];
  const xFrameOptions = headers.get("x-frame-options");
  const csp = headers.get("content-security-policy");
  const frameAncestors = csp?.match(/frame-ancestors\s+([^;]+)/i)?.[1]?.trim() ?? null;

  if (xFrameOptions) {
    errors.push(
      `X-Frame-Options must be absent on embed paths (got ${xFrameOptions}). ` +
        "If next.config is correct, check Cloudflare Transform Rules / Security Headers.",
    );
  }
  if (!frameAncestors) {
    errors.push("Content-Security-Policy frame-ancestors missing");
  } else {
    if (!frameAncestors.includes("nui:")) {
      errors.push("frame-ancestors must include nui:");
    }
    const ancestorTokens = frameAncestors.split(/\s+/);
    if (ancestorTokens.includes("*")) {
      errors.push("frame-ancestors must not use * (broken for nui:// and too permissive)");
    }
    if (/cfx-nui-[^;\s]*_/.test(frameAncestors)) {
      errors.push(
        "frame-ancestors contains invalid cfx-nui host with underscore (Chromium rejects it)",
      );
    }
  }

  return {
    ok: errors.length === 0,
    path,
    xFrameOptions,
    csp,
    frameAncestors,
    errors,
  };
}

export type StaffHeaderCheckResult = {
  ok: boolean;
  path: string;
  xFrameOptions: string | null;
  frameAncestors: string | null;
  errors: string[];
};

export function verifyStaffResponseHeaders(path: string, headers: Headers): StaffHeaderCheckResult {
  const errors: string[] = [];
  const xFrameOptions = headers.get("x-frame-options");
  const csp = headers.get("content-security-policy");
  const frameAncestors = csp?.match(/frame-ancestors\s+([^;]+)/i)?.[1]?.trim() ?? null;

  if (xFrameOptions?.toUpperCase() !== "SAMEORIGIN") {
    errors.push(`X-Frame-Options must be SAMEORIGIN (got ${xFrameOptions ?? "absent"})`);
  }
  if (frameAncestors?.includes("nui:")) {
    errors.push("staff path must not allow nui: frame-ancestors");
  }

  return { ok: errors.length === 0, path, xFrameOptions, frameAncestors, errors };
}
