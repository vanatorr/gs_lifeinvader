import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import {
  listCandidateJobs,
  listPortals,
  networkAdminFor,
  portalTemplates,
} from "@/lib/business/network";
import ReseauView from "./ReseauView";

export const dynamic = "force-dynamic";

/**
 * LA CONSOLE RÉSEAU: qui a un portail LifeInvader, et qui devrait en avoir un.
 *
 * ⚠ `notFound()` ET NON UNE PAGE "INTERDIT", exactement comme la coquille d'un commerce. Une page
 * d'erreur nommée confirmerait à qui essaie l'adresse que cette console existe; un 404 ne dit rien.
 *
 * ⚠ CETTE PAGE N'EST PAS LA PORTE. Elle re-résout son propre accès (une mise en page n'est jamais une
 * frontière, et Next peut rendre une page sans sa mise en page parente lors d'une navigation côté
 * client), et CHAQUE action de `actions.ts` re-résout le sien, parce qu'un Server Action est un POST
 * public à l'URL de cette page, joignable sans jamais l'avoir chargée. La liste ci-dessous est de la
 * présentation; ce qui protège les écritures est dans les actions.
 */
export default async function ReseauPage() {
  const identity = await requireIdentity();
  const admin = await networkAdminFor(identity);
  if (!admin) notFound();

  const [portals, candidates] = await Promise.all([listPortals(), listCandidateJobs()]);

  return (
    <ReseauView
      portals={portals}
      candidates={candidates}
      templates={portalTemplates()}
      // D'où vient l'accès. Affichage seulement: les deux moitiés de la porte ouvrent exactement la
      // même console, et rien ici n'en dépend pour décider quoi que ce soit.
      via={admin.viaStaff ? (admin.viaJob ? "les deux" : "rang staff") : "direction MIRAGE"}
    />
  );
}
