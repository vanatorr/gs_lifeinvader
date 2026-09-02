import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { frameHeadersFor } from "@/lib/security/ingameEmbed";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ORIGIN_EXEMPT_PREFIXES = [
  "/api/auth",
  "/api/tebex",
  "/api/game/photo-upload",
  "/api/game/photo-upload-ticket",
];

function forwardedHost(req: NextRequest): string {
  return req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.nextUrl.host;
}

function forwardedProto(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ||
    req.nextUrl.protocol.replace(":", "")
  );
}

function requestOrigin(req: NextRequest): string {
  return `${forwardedProto(req)}://${forwardedHost(req)}`;
}

function isOriginExempt(pathname: string): boolean {
  return ORIGIN_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;

  try {
    return new URL(origin).origin === requestOrigin(req);
  } catch {
    return false;
  }
}

function sameFetchSite(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  return !site || site === "same-origin" || site === "same-site" || site === "none";
}

/**
 * Defense in depth for gs_website iframe embed:
 * - Re-apply allowlisted frame-ancestors on every embed path (catches redirect targets).
 * - Strip X-Frame-Options if a catch-all header rule leaked SAMEORIGIN onto /cad.
 */
/**
 * LE PORTAIL COMMERCES A SON PROPRE HOTE: lifeinvader.grandside.org.
 *
 * Il sert la MEME application que citadel.grandside.org, mais sous la marque que lisent les joueurs.
 * On REECRIT plutot qu'on ne REDIRIGE: toutes les URL du portail sont absolues (`/business/<slug>/...`
 * dans les liens du rail), donc une redirection renverrait le joueur sur l'hote CITADEL a chaque clic
 * et la marque ne tiendrait pas une seconde.
 *
 * ⚠ `/api`, `/_next` et les fichiers statiques NE SONT PAS REECRITS. Les faire passer par /business
 * casserait la connexion elle-meme: le rappel OAuth vit sous `/api/auth`, et le reecrire en
 * `/business/api/auth` le rend introuvable. La panne serait "impossible de se connecter", sans
 * rapport visible avec une regle de reecriture.
 *
 * ⚠ Consequence VOULUE: sur cet hote, /staff et /cad deviennent /business/staff et /business/cad,
 * qui n'existent pas. Le panneau du staff n'est donc pas joignable depuis la marque joueur, sans
 * qu'aucune regle de blocage ait a etre maintenue a jour. C'est l'absence de route qui ferme la
 * porte, pas une liste noire que quelqu'un oubliera d'allonger.
 */
const BUSINESS_HOST = process.env.BUSINESS_HOST?.toLowerCase() || "lifeinvader.grandside.org";

/**
 * Prefixes qui doivent atteindre l'application TELLE QUELLE, quel que soit l'hote.
 *
 * ⚠⚠ TOUT CE QUI SERT A SE CONNECTER EN FAIT PARTIE, et l'oublier rend la marque INUTILISABLE.
 * Premiere version: seuls `/api` et les statiques etaient exemptes, donc `/login` devenait
 * `/business/login`, une route qui n'existe pas. Resultat: la page de connexion rendait 404 sur
 * lifeinvader.grandside.org, et comme toute page du portail commence par y rediriger, PERSONNE ne
 * pouvait entrer. Le portail avait l'air casse alors que seule la porte l'etait.
 *
 * `/auth` couvre le lien de connexion distribue en jeu (`/auth/ingame`), qui a exactement le meme
 * probleme et se serait vu plus tard, une fois la connexion Discord reparee.
 *
 * Regle a retenir en ajoutant une marque: on reecrit ce qui appartient au PRODUIT, jamais ce qui
 * appartient a la SESSION.
 */
const NEVER_REWRITTEN = [
  "/api",
  "/login",
  "/auth",
  "/_next",
  "/favicon",
  "/icon",
  "/robots",
  "/sitemap",
];

/**
 * Un fichier, par opposition a une page.
 *
 * ⚠ SANS CETTE REGLE, TOUT LE CONTENU DE `public/` EST CASSE SUR LA MARQUE JOUEUR. Les fichiers de
 * `public/` sont servis a la RACINE (`/grandside-logo.png`), pas sous `/_next`, donc la reecriture
 * les transformait en `/business/grandside-logo.png`: 404. Mesure du 2026-08-09, avant correctif:
 * `/grandside-logo.png` rendait 200 sur citadel et 404 sur lifeinvader, ce qui cassait l'image de
 * la page de connexion et l'icone du portail, sur la marque joueur uniquement.
 *
 * On teste la presence d'un point dans le DERNIER segment plutot que de tenir une liste de
 * fichiers: une liste se perime au premier fichier ajoute, et l'echec est un 404 silencieux sur une
 * seule des deux marques, c'est a dire la panne la plus facile a ne pas voir. Aucune page du portail
 * n'a de point dans son chemin, donc la regle ne peut pas avaler une route.
 */
function isStaticAsset(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

function isBusinessHost(req: NextRequest): boolean {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  return host === BUSINESS_HOST;
}

/**
 * Applique la politique d'encadrement sur TOUTE reponse que ce middleware renvoie.
 *
 * ⚠ Chaque `return` de `middleware()` doit passer par ici. Le trou corrige le 2026-08-26 venait
 * exactement de la: la reecriture par hote renvoyait sa reponse AVANT toute pose d'en-tete, donc le
 * portail commerces servait `/reseau` et `/caisse` sans CSP ni X-Frame-Options sur sa propre marque.
 * Le choix (verrouille ou encadrable en jeu) est pris dans `frameHeadersFor`, pas ici.
 */
function withFrameHeaders(
  response: NextResponse,
  pathname: string,
  businessHost: boolean,
): NextResponse {
  const { csp, xFrameOptions } = frameHeadersFor({ pathname, businessHost });
  response.headers.set("Content-Security-Policy", csp);
  if (xFrameOptions) {
    response.headers.set("X-Frame-Options", xFrameOptions);
  } else {
    // Les routes encadrables en jeu n'en veulent JAMAIS: X-Frame-Options n'a pas de liste blanche,
    // donc un SAMEORIGIN pose par une regle fourre-tout casserait le tablet in-game en silence.
    response.headers.delete("X-Frame-Options");
  }
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const businessHost = isBusinessHost(request);

  /**
   * ⚠ SUR LA MARQUE JOUEUR, LE PREFIXE `/business` NE DOIT JAMAIS APPARAITRE DANS LA BARRE
   * D'ADRESSE. Tous les liens du portail sont ecrits en absolu (`/business/<slug>/caisse`), parce
   * que c'est la seule forme correcte sur la marque staff. Sur la marque joueur ils fonctionnent
   * aussi, la reecriture les laissant passer tels quels, mais ils AFFICHENT le prefixe, ce qui
   * revient a montrer la plomberie interne comme si c'etait l'adresse du produit.
   *
   * On redirige (308, permanent et conservant la methode) plutot que de reecrire chaque lien dans
   * chaque page: une redirection au bord ne peut pas etre oubliee par une page ecrite plus tard,
   * alors qu'un helper de lien, si. Les deux formes restent donc valides, mais une seule survit
   * dans la barre d'adresse.
   */
  if (businessHost && pathname.startsWith("/business")) {
    const stripped = pathname.slice("/business".length) || "/";
    const url = request.nextUrl.clone();
    url.pathname = stripped;
    return NextResponse.redirect(url, 308);
  }

  /**
   * ⚠⚠ LE CONTROLE D'ORIGINE PASSE AVANT LA REECRITURE PAR HOTE, ET CET ORDRE EST LA CORRECTION.
   *
   * Il etait place APRES: sur la marque joueur, toute Server Action arrive sur un chemin propre
   * (`/caisse`, `/reseau`), donc elle entrait dans la reecriture, qui renvoie immediatement, et le
   * controle n'etait JAMAIS execute. Le portail commerces etait ainsi la seule surface d'ecriture de
   * l'application dispensee du controle, ce que le commentaire du `matcher` plus bas affirmait
   * pourtant impossible. Le cookie de session in-game etant `SameSite=None`, la defense propre du
   * navigateur ne comblait pas le trou non plus.
   */
  if (
    UNSAFE_METHODS.has(request.method.toUpperCase()) &&
    !isOriginExempt(pathname) &&
    (!sameOrigin(request) || !sameFetchSite(request))
  ) {
    return new NextResponse("Cross-origin request blocked", { status: 403 });
  }

  if (
    businessHost &&
    !pathname.startsWith("/business") &&
    !isStaticAsset(pathname) &&
    !NEVER_REWRITTEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/" ? "/business" : `/business${pathname}`;
    return withFrameHeaders(NextResponse.rewrite(url), pathname, businessHost);
  }

  return withFrameHeaders(NextResponse.next(), pathname, businessHost);
}

export const config = {
  matcher: [
    "/",
    "/auth/ingame",
    "/login",
    "/cad",
    "/cad/:path*",
    "/profile",
    "/profile/:path*",
    "/api/:path*",
    "/staff/:path*",
    // ⚠ /business doit y figurer, sinon le contrôle d'origine sur les POST (voir sameOrigin /
    //   sameFetchSite plus haut) ne tourne JAMAIS sur ses Server Actions, et le portail est la
    //   seule surface d'écriture de l'application à en être dispensée.
    "/business",
    "/business/:path*",
    /**
     * ⚠ CE FOURRE-TOUT EST INDISPENSABLE A LA REECRITURE PAR HOTE. Les entrees ci-dessus listent des
     * CHEMINS; or sur lifeinvader.grandside.org le chemin demande est `/`, `/caisse`, n'importe quoi,
     * et il doit etre reecrit AVANT que Next ne cherche une route. Sans cette ligne, l'hote joueur
     * ne servirait que les quelques chemins deja listes et rendrait 404 partout ailleurs.
     * Les fichiers statiques et les images sont exclus ici pour ne pas payer le middleware dessus.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
