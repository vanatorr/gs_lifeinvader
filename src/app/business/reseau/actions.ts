"use server";

import { revalidatePath } from "next/cache";
import { requireIdentity } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import {
  createPortal,
  isNetworkAdmin,
  resetPortalLook,
  updatePortal,
  type PortalError,
} from "@/lib/business/network";

/**
 * LES ACTIONS DE LA CONSOLE RÉSEAU.
 *
 * ⚠⚠ CHAQUE ACTION RE-RÉSOUT `isNetworkAdmin`, ET C'EST LA SEULE CHOSE QUI PROTÈGE QUOI QUE CE SOIT.
 * Un Server Action est un POST public à l'URL de la page: on peut l'appeler sans avoir jamais chargé
 * /business/reseau, sans avoir vu le moindre bouton, et la signature TypeScript n'est qu'une
 * déclaration d'intention. Même discipline que gestion/reglages/actions.ts, avec un enjeu plus
 * grand: ces actions-là touchent le portail d'entreprises qui ne sont pas les nôtres.
 *
 * ⚠ TOUT EST AUDITÉ. Ouvrir, renommer, déplacer l'adresse ou fermer le portail d'autrui est une
 * DÉCISION prise sur le bien de quelqu'un d'autre, et c'est exactement ce que `citadel_audit`
 * enregistre (par opposition à l'attention, qui ne s'audite pas: voir markTicketReadAction). Le
 * commerce touché est la CIBLE, jamais l'auteur.
 */

export type ReseauState = { status: "ok"; slug?: string } | { status: "error"; message: string };

const DENIED = "Vous n'administrez pas le réseau LifeInvader.";

/** On ne renvoie jamais le code brut: chaque motif dit quoi FAIRE. */
const MESSAGES: Record<PortalError, string> = {
  bad_job:
    "Métier invalide. Le métier `unemployed` est refusé: ESX y range tout le monde par défaut, " +
    "un portail dessus serait ouvert au serveur entier.",
  unknown_job: "Ce métier n'existe pas dans la table jobs du jeu. Créez-le en jeu d'abord.",
  job_taken: "Ce métier a déjà un portail. Modifiez-le dans la liste plutôt que d'en ouvrir un second.",
  bad_name: "Il faut une enseigne, de 1 à 120 caractères.",
  bad_slug:
    "Adresse invalide. Minuscules, chiffres et tirets seulement, sans tiret au début ni à la fin. " +
    "`reseau` est réservé à cette console.",
  slug_taken: "Cette adresse est déjà prise par un autre portail.",
  unknown_template: "Modèle inconnu.",
  not_found: "Ce portail n'existe plus. Rechargez la page.",
};

/** La garde, en une ligne, pour qu'aucune action ne puisse l'oublier en la recopiant. */
async function requireNetworkAdmin() {
  const identity = await requireIdentity();
  return (await isNetworkAdmin(identity)) ? identity : null;
}

function refresh(slug?: string) {
  revalidatePath("/business/reseau");
  revalidatePath("/business");
  if (slug) revalidatePath(`/business/${slug}`);
}

export async function createPortalAction(input: {
  job: string;
  name: string;
  slug: string;
  template: string;
}): Promise<ReseauState> {
  const identity = await requireNetworkAdmin();
  if (!identity) return { status: "error", message: DENIED };

  const res = await createPortal({
    job: String(input.job ?? ""),
    name: String(input.name ?? ""),
    slug: String(input.slug ?? ""),
    template: String(input.template ?? ""),
  });
  if (!res.ok) return { status: "error", message: MESSAGES[res.error] };

  await audit(identity, {
    panel: "business",
    action: "business.portal.create",
    targetType: "business",
    targetId: res.id,
    data: { job: input.job, name: input.name, slug: res.slug, template: input.template },
  });

  refresh(res.slug);
  return { status: "ok", slug: res.slug };
}

export async function updatePortalAction(
  id: number,
  input: { name?: string; slug?: string; template?: string; active?: boolean },
): Promise<ReseauState> {
  const identity = await requireNetworkAdmin();
  if (!identity) return { status: "error", message: DENIED };
  if (!Number.isInteger(id) || id <= 0) return { status: "error", message: MESSAGES.not_found };

  const res = await updatePortal(id, input);
  if (!res.ok) return { status: "error", message: MESSAGES[res.error] };

  await audit(identity, {
    panel: "business",
    action: "business.portal.update",
    targetType: "business",
    targetId: id,
    data: input,
  });

  refresh(input.slug);
  return { status: "ok", slug: input.slug };
}

/**
 * Repasser la palette et les rayons du modèle.
 *
 * Refusé si un article vit encore dans un rayon que le modèle ne porte pas: l'article resterait en
 * base sans jamais s'afficher, la caisse groupant par rayon déclaré.
 */
export async function resetPortalLookAction(id: number): Promise<ReseauState> {
  const identity = await requireNetworkAdmin();
  if (!identity) return { status: "error", message: DENIED };
  if (!Number.isInteger(id) || id <= 0) return { status: "error", message: MESSAGES.not_found };

  const res = await resetPortalLook(id);
  if (!res.ok) {
    return {
      status: "error",
      message:
        res.error === "not_found"
          ? MESSAGES.not_found
          : `Des articles vivent encore dans un rayon absent du modèle (${res.detail}). ` +
            "Déplacez-les depuis le Catalogue de ce commerce avant de réinitialiser.",
    };
  }

  await audit(identity, {
    panel: "business",
    action: "business.portal.reset_look",
    targetType: "business",
    targetId: id,
  });

  refresh();
  return { status: "ok" };
}
