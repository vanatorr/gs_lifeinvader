"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * CE QUI FAIT QUE LA PRISE DE SERVICE SE VOIT SANS RECHARGER.
 *
 * ⚠ IL NE DESSINE RIEN ET NE DÉCIDE RIEN. Il regarde une valeur que le serveur a déjà calculée et,
 * quand elle change, demande au serveur de redessiner. Tout le palier, tous les droits et toutes les
 * entrées du rail restent calculés côté serveur par `getBusinessAccess`: ce fichier ne connaît même
 * pas la règle, il connaît seulement l'instant où il faut la reposer.
 *
 * ⚠ ON SONDE UNE ROUTE MINUSCULE, ON NE RAFRAÎCHIT PAS EN BOUCLE. `router.refresh()` rejoue TOUTE
 * la page (la coquille, la caisse, le catalogue, leurs requêtes); le faire toutes les dix secondes
 * pour tout le monde en permanence coûterait cher pour ne rien changer 99 fois sur 100, puisque le
 * palier ne bouge que deux fois par service. Le sondage lit un objet de trois champs et ne déclenche
 * le rendu QUE sur une transition réelle. Au repos, le coût est une requête courte par onglet.
 *   → Précédent inverse dans ce dossier: `PointageView` rafraîchit à l'aveugle chaque minute. C'est
 *     défendable là-bas (une page de consultation, ouverte le temps de regarder) et ça ne l'est pas
 *     ici, où la coquille vit sur toutes les pages du portail pendant tout un service.
 *
 * ⚠ RIEN NE TOURNE DANS UN ONGLET CACHÉ, et c'est le cas d'usage central, pas une optimisation:
 * on prend son service EN JEU, donc le navigateur est derrière le jeu à ce moment précis. Un
 * intervalle qui continue dans un onglet caché sonde pour personne; ce qu'il faut, c'est mesurer
 * À NOUVEAU quand la personne revient. On sonde donc au retour de visibilité, tout de suite, ce qui
 * rend la mise à jour immédiate dans le seul moment où quelqu'un la regarde.
 *
 * ⚠ LA COMPARAISON SE FAIT SUR LA DERNIÈRE VALEUR CONNUE, PAS SUR LA PROP. Un rafraîchissement
 * prend le temps d'un aller-retour serveur; comparer à la prop pendant ce temps redemanderait le
 * même rendu à chaque tick jusqu'à ce qu'il arrive. On retient donc ce qu'on a vu, et un
 * rafraîchissement est demandé une fois par transition.
 */
export default function PresenceWatch({
  slug,
  tier,
  identifier,
  intervalMs = 12_000,
}: {
  slug: string;
  /** Le palier avec lequel le serveur a rendu cette page. */
  tier: string;
  /** Le personnage qui tient ce commerce dans ce rendu. */
  identifier: string;
  intervalMs?: number;
}) {
  const router = useRouter();
  const seen = useRef(`${tier}|${identifier}`);

  // Le serveur vient de redessiner: ce qu'il a rendu devient la nouvelle référence. Sans ça, un
  // rafraîchissement déclenché par autre chose (une action, une navigation) laisserait une
  // référence périmée et provoquerait un second rendu inutile au tick suivant.
  useEffect(() => {
    seen.current = `${tier}|${identifier}`;
  }, [tier, identifier]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();

    const check = async () => {
      if (!alive || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/business/${encodeURIComponent(slug)}/presence`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) return; // session expirée ou erreur: la page reste telle quelle, sans clignoter
        const data: { tier?: string | null; identifier?: string | null } = await res.json();
        if (!alive || !data.tier) return;
        const next = `${data.tier}|${data.identifier ?? ""}`;
        if (next === seen.current) return;
        seen.current = next;
        router.refresh();
      } catch {
        // Réseau coupé, onglet en train de se fermer, navigation: rien à signaler et surtout rien
        // à casser. Le prochain tick reposera la question.
      }
    };

    const timer = window.setInterval(check, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug, intervalMs, router]);

  return null;
}
