"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calculator,
  ChartNoAxesCombined,
  Clock,
  Lock,
  Network,
  ReceiptText,
  Settings,
  Tags,
  Users,
} from "lucide-react";
import s from "../shell.module.css";

/**
 * LES ENTREES DU RAIL, ET LA SEULE CHOSE QUI OBLIGE A UN COMPOSANT CLIENT: "VOUS ETES ICI".
 *
 * ⚠ Une mise en page de l'App Router ne connait pas l'URL courante. Elle recoit ses `params` et
 * rien d'autre, il n'existe aucun equivalent serveur de `usePathname`, et l'en-tete `Next-Url`
 * n'accompagne que les navigations cote client (donc jamais le premier chargement). Un rail qui
 * n'indique pas la page courante etait la lacune L2 du systeme de design: `aria-current` n'etait
 * pose nulle part et `.nav[aria-current="true"]`, la regle de chrome la plus utilisee de la
 * maquette, etait inerte. Ce composant existe pour ca, et pour rien d'autre. Meme precedent que
 * `src/app/cad/CadTopbar.tsx`, qui resout le meme probleme de la meme facon.
 *
 * ⚠ CE N'EST PAS UNE PORTE. `ok` et `why` sont calcules par la mise en page cote SERVEUR, a partir
 * de `businessCan`, et chaque page comme chaque Server Action re-resout son acces pour elle-meme.
 * Ce fichier ne fait que dessiner un verdict deja rendu: le masquer ou le montrer ne change aucun
 * droit.
 *
 * ⚠ `aria-current="page"` et non `"true"`. La maquette ecrivait `aria-current="true|false"`, ce qui
 * est valide mais moins precis; `page` est la valeur que les lecteurs d'ecran annoncent comme "page
 * courante". La regle de style vit donc ici (`.item[aria-current]`) plutot que dans la feuille
 * globale, qui attend encore `="true"`.
 */

/** Le nom d'icone voyage en CHAINE: un composant React ne traverse pas la frontiere serveur. */
const ICONS = {
  caisse: Calculator,
  ventes: ReceiptText,
  equipe: Users,
  analytique: ChartNoAxesCombined,
  pointage: Clock,
  catalogue: Tags,
  reglages: Settings,
  reseau: Network,
} as const;

export type NavIcon = keyof typeof ICONS;

export type NavItem = {
  href: string;
  label: string;
  ok: boolean;
  /** POURQUOI l'entree est barree, en une formule que la personne peut suivre. */
  why: string;
  icon: NavIcon;
  group: "poste" | "gestion" | "reseau";
};

const GROUPS: { key: NavItem["group"]; label: string }[] = [
  { key: "poste", label: "Mon poste" },
  { key: "gestion", label: "Gestion" },
  // Un groupe a part, et pas une entree de plus sous "Gestion": ce qu'on y fait ne concerne PAS le
  // commerce affiche, il concerne le portail de tout le monde. Les ranger ensemble ferait croire
  // qu'on administre l'enseigne ouverte.
  { key: "reseau", label: "Réseau" },
];

export default function ShellNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  /**
   * Le prefixe et pas l'egalite stricte: la fiche d'un employe vit sous `gestion/equipe/<id>`, et
   * une entree qui s'eteint des qu'on ouvre un detail donne l'impression d'avoir quitte la section.
   * Le `/` final evite qu'un chemin plus long mais different (`.../caissexyz`) soit pris pour un
   * enfant.
   */
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className={s.groups}>
      {GROUPS.map((g) => {
        const rows = items.filter((n) => n.group === g.key);
        if (rows.length === 0) return null;
        return (
          <div className={s.group} key={g.key}>
            {/* Le titre de groupe n'apparait que si un second groupe existe: un employe sans
                aucune entree de gestion n'a pas besoin qu'on lui nomme la seule liste presente. */}
            {items.some((n) => n.group !== g.key) ? (
              <div className={s.gcap}>
                {g.label}
                <i />
              </div>
            ) : null}
            <div className={s.items}>
              {rows.map((n) => {
                const Icon = ICONS[n.icon];
                return n.ok ? (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={s.item}
                    aria-current={isCurrent(n.href) ? "page" : undefined}
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className={s.ilabel}>{n.label}</span>
                  </Link>
                ) : (
                  <span key={n.href} className={s.blocked} aria-disabled="true">
                    <Lock size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span>
                      <span className={s.ilabel}>{n.label}</span>
                      <span className={s.iwhy}>{n.why}</span>
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
