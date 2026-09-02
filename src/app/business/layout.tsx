import type { Metadata } from "next";
import { requireIdentity } from "@/lib/auth/session";
import "./business.css";

/**
 * LIFEINVADER ENTREPRISES - la racine du portail commerces.
 *
 * Cette couche ne garantit qu'une chose: une identité SIGNÉE et LIÉE. La vraie porte (travaillez-vous
 * ici, à quel grade, et êtes-vous en service) est le travail de la couche `[slug]`, parce qu'elle est
 * par commerce et dépendante de la présence, ce qu'une racine ne peut pas savoir.
 *
 * ⚠ UNE MISE EN PAGE N'EST JAMAIS UNE FRONTIÈRE DE SÉCURITÉ. Next peut rendre une page sans sa mise
 * en page parente lors d'une navigation côté client, et un Server Action est un POST public à l'URL
 * de la page. Chaque page ET chaque action sous /business re-résout donc son accès pour elle-même.
 *
 * ⚠ AUCUNE FONTE N'EST CHARGÉE ICI, et c'est le correctif d'un vrai bug. `src/app/layout.tsx`
 * importe déjà Hanken Grotesk et JetBrains Mono via `@fontsource`, c'est-à-dire EXACTEMENT les deux
 * fontes de la maquette, auto-hébergées pour toute l'application. Une première version ajoutait
 * `next/font` par-dessus et faisait pointer `--sans` sur sa variable: la variable n'existait que sur
 * le <div> de cette couche alors que `--sans` est déclarée sur `:root`, donc la déclaration devenait
 * invalide et tout le portail s'affichait dans la police par défaut. Voir business.css pour le
 * mécanisme exact. Nommer la famille suffit; ajouter un second chargeur ne pouvait qu'ajouter un
 * conflit.
 */

export const metadata: Metadata = {
  title: "LifeInvader Entreprises",
  description: "Caisse, ventes et pointages des entreprises de GrandSide.",
};

export const dynamic = "force-dynamic";

export default async function BusinessRootLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return <>{children}</>;
}
