"use server";

import { revalidatePath } from "next/cache";
import { requireIdentity } from "@/lib/auth/session";
import { requireBusiness } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { correctShift, type CorrectShiftError } from "@/lib/business/shifts";

/**
 * L'ACTION DE CORRECTION DE POINTAGE.
 *
 * ⚠⚠ RE-RÉSOUT SON ACCÈS: un Server Action est un POST public à l'URL de la page, joignable sans
 * jamais avoir chargé /gestion/pointage. Le contrôle fait au rendu de la page ne protège rien ici.
 * On re-résout aussi parce que la page a pu rester ouverte pendant que la personne quittait son
 * service, ou perdait le droit qu'un patron venait de lui retirer depuis les Réglages.
 *
 * ⚠ `access.job` est passé à `correctShift`, jamais un `job` fourni par le client: le navigateur
 * n'envoie qu'un identifiant de pointage et deux dates, jamais l'entreprise qu'il pense corriger.
 */

export type CorrectShiftState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

/**
 * Un motif de refus par code, en français et adressé à la personne qui vient de cliquer.
 *
 * ⚠ CHAQUE MESSAGE DIT QUOI FAIRE. On ne renvoie jamais le code brut au navigateur ("still_open" ne
 * dit rien à un gérant qui ne connaît pas le schéma), et un refus qui se contente de constater
 * ("introuvable", "trop longue") laisse quelqu'un recliquer le même bouton en boucle.
 *
 * ⚠ `not_found` ET `wrong_job` PARTAGENT LE MÊME TEXTE, AU MOT PRÈS, et ce n'est pas une économie:
 * `correctShift` renvoie déjà volontairement le même code pour "ce pointage n'existe pas" et "ce
 * pointage appartient à un autre commerce". Les distinguer ici rétablirait exactement la fuite que
 * la requête évite: confirmer, à qui devine un identifiant, qu'un pointage existe chez le voisin.
 *
 * ⚠ `too_long` reste volontairement flou sur le nombre d'heures exact: la vraie borne vit dans
 * `correctShift` (MAX_CORRECTED_HOURS), et la répéter ici créerait un second nombre à tenir
 * synchronisé avec le premier pour un message qui n'en a pas besoin.
 */
const CORRECT_MESSAGES: Record<CorrectShiftError, string> = {
  not_found:
    "Ce pointage n'existe plus. Rechargez la page: il a pu être corrigé ou supprimé entre-temps.",
  wrong_job:
    "Ce pointage n'existe plus. Rechargez la page: il a pu être corrigé ou supprimé entre-temps.",
  still_open:
    "Cette personne est en service en ce moment: le jeu réécrirait la correction au prochain battement. Attendez la fin de son service, la page se met à jour toute seule.",
  inverted: "L'heure de fin doit être après l'heure de début. Corrigez l'une des deux dates.",
  too_long:
    "Aucun service ne dure aussi longtemps. Vérifiez le JOUR des deux dates: c'est presque toujours une fin datée du lendemain.",
};

export async function correctShiftAction(
  slug: string,
  input: { shiftId: number; startedAt: string; endedAt: string },
): Promise<CorrectShiftState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SHIFT_EDIT);
  if (!access) {
    // ⚠ Le refus est VOLONTAIREMENT le même pour les trois causes (droit absent, module éteint,
    // service non pris): la page, elle, sait laquelle et l'écrit, parce qu'elle a l'accès complet
    // sous la main. Ici on ne peut pas le savoir sans re-résoudre l'accès une seconde fois, et
    // deviner "prise de service requise" est ce qui envoyait quelqu'un pointer pour un droit que
    // son grade n'a pas. Une phrase qui renvoie à la page est plus utile qu'une cause inventée.
    return {
      status: "error",
      message:
        "Vous ne pouvez pas corriger ce pointage. Rechargez la page: le motif exact y est indiqué.",
    };
  }

  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return {
      status: "error",
      message: "Renseignez le jour et l'heure, pour la prise comme pour la fin de service.",
    };
  }

  const res = await correctShift(access.job, input.shiftId, { startedAt, endedAt });
  if (!res.ok) {
    return { status: "error", message: CORRECT_MESSAGES[res.error] ?? "La correction a échoué." };
  }

  revalidatePath(`/business/${slug}/gestion/pointage`);
  return { status: "ok" };
}
