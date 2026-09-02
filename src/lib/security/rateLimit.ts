type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfter: number;
};

const buckets =
  ((globalThis as typeof globalThis & { __citadelRateLimitBuckets?: Map<string, Bucket> })
    .__citadelRateLimitBuckets ??= new Map<string, Bucket>());

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ⚠⚠ L'ORDRE DE CES TROIS EN-TETES EST LA SECURITE, ET IL ETAIT A L'ENVERS.
 *
 * `x-forwarded-for` etait lu EN PREMIER, et son element [0]. Or Cloudflare n'ECRASE pas cet en-tete:
 * il AJOUTE l'IP reelle du visiteur a la suite de ce que le client a envoye. L'element [0] est donc
 * exactement ce que l'appelant a tape, jamais son adresse. Un attaquant envoyant un
 * `X-Forwarded-For: <valeur aleatoire>` different a chaque requete obtient un seau neuf a chaque
 * fois, ce qui annule SILENCIEUSEMENT toutes les limites de l'application: `/auth/ingame` (20/min),
 * `/api/store/verify-phone` (10/min, dimensionnee contre un espace de 10 000 numeros),
 * `/api/tebex`, `/api/game/*` et `/api/stream`.
 *
 * Le degat ne s'arrete pas aux limites. La meme fonction alimente `citadel_audit.ip` et l'IP liee au
 * filigrane de tracage: une valeur forgee s'ecrit donc dans la preuve elle-meme, et quelqu'un qui
 * exfiltre des dossiers peut y deposer l'IP de quelqu'un d'autre.
 *
 * `cf-connecting-ip` est pose par Cloudflare et ECRASE toute valeur envoyee par le client: c'est le
 * seul des trois qui ne soit pas falsifiable derriere ce bord. On le lit donc en premier, puis
 * `x-real-ip`, et `x-forwarded-for` seulement en dernier recours et par sa DERNIERE entree (celle
 * ajoutee par le proxy le plus proche), jamais la premiere (celle choisie par le client).
 */
export function clientIpFromHeaders(h: Headers): string | null {
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const real = h.get("x-real-ip")?.trim();
  if (real) return real;

  const chain = h.get("x-forwarded-for");
  if (chain) {
    const hops = chain.split(",").map((s) => s.trim()).filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }

  return null;
}

export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const bucketKey = key.slice(0, 160);

  if (buckets.size > 10_000) prune(now);

  const current = buckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count <= limit) return { allowed: true, retryAfter: 0 };

  return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
}

export function rateLimitHeaders(retryAfter: number): HeadersInit {
  return retryAfter > 0 ? { "Retry-After": String(retryAfter) } : {};
}
