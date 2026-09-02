/**
 * LE PALIER DE PRÉSENCE, EN UNE LIGNE, POUR QUE LA PAGE SACHE QUAND SE REDESSINER.
 *
 * ⚠⚠ POURQUOI CETTE ROUTE EXISTE. Le palier (`session` / `ingame` / `service`) est calculé côté
 * SERVEUR au rendu, à partir de deux tables que seul le JEU écrit (`citadel_online`,
 * `lifeinvader_business_shifts`). Une page rendue ne se remesure donc jamais toute seule: quelqu'un
 * ouvrait le portail hors service, prenait son service en jeu, et le portail continuait d'afficher
 * "En jeu" avec la Caisse barrée jusqu'à un rechargement manuel. Signalé par le propriétaire
 * ("quand tu te mets en service, website doesnt update, you need to refresh"). Le manque n'était pas
 * dans la mesure, qui a toujours été juste, mais dans le fait que rien ne la reprenait.
 *
 * ⚠ CE N'EST PAS UNE PORTE, ET ELLE N'EN OUVRE AUCUNE. Elle ne rend qu'un palier déjà calculé par
 * `getBusinessBySlug`, la MÊME fonction que la mise en page et que chaque Server Action. Elle ne
 * décide rien, n'écrit rien, et ne dit rien de plus que ce que la page affiche déjà à qui la
 * regarde. Un commerce où l'on ne travaille pas rend `null`, jamais 403: distinguer "n'existe pas"
 * de "pas à vous" confirmerait l'existence d'une enseigne à qui essaie des slugs, exactement comme
 * le `notFound()` de la mise en page.
 *
 * ⚠ PAS DE HMAC ICI, contrairement à /api/site/*. Ces routes-là parlent à un AUTRE service (la
 * boutique publique) et la signature protège le pont. Celle-ci parle au navigateur de la personne
 * déjà connectée, dont la session EST l'authentification; y ajouter un secret partagé ne
 * protégerait rien et donnerait un secret de plus à faire fuiter.
 *
 * ⚠ `no-store` n'est pas décoratif: une réponse mise en cache par le navigateur ou par un
 * intermédiaire ferait mentir le sondage pendant toute la durée du cache, ce qui est précisément le
 * bug qu'on corrige, avec une couche de plus pour le retrouver.
 */
import { NextResponse } from "next/server";
import { resolveSessionIdentity } from "@/lib/auth/session";
import { getBusinessBySlug } from "@/lib/business/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;

  // `resolveSessionIdentity` et non `requireIdentity`: ce dernier fait un `redirect()`, donc un
  // sondage sur une session expirée recevrait la page de connexion en HTML au lieu d'un statut, et
  // le client passerait son temps à échouer sur un JSON.parse sans jamais savoir pourquoi.
  const identity = await resolveSessionIdentity();
  if (!identity) {
    return NextResponse.json({ tier: null, reason: "session" }, { status: 401, headers: NO_STORE });
  }

  const access = await getBusinessBySlug(identity, slug);
  if (!access) {
    return NextResponse.json({ tier: null, reason: "access" }, { status: 200, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      tier: access.tier,
      onDuty: access.onDuty,
      // Le personnage QUI OUVRE ce commerce fait partie de l'état: sur un compte à plusieurs
      // personnages, prendre son service sur un autre personnage change qui tient la caisse sans
      // changer le palier. Sans ça, ce cas précis resterait exactement le bug qu'on corrige.
      identifier: access.identifier,
    },
    { headers: NO_STORE },
  );
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
