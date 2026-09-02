"use client";

import { visualFor } from "@/lib/business/art";
import { money, priceParts, toneVars } from "@/lib/business/theme";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

/**
 * LA VIGNETTE PRODUIT, DESSINÉE EXACTEMENT COMME LA CAISSE LA DESSINE (les données, pas le chrome).
 *
 * ⚠⚠ REDESSINÉE EN CARTE shadcn LE 2026-08-09. `.tile`/`.tvis` (business.css) restaient la vignette
 * de la CAISSE, qui est hors périmètre de ce chantier: cette fiche du catalogue est la SEULE
 * consommatrice de ce fichier (aucun import hors de ce dossier), donc lui donner son propre chrome
 * `<Card>` ne fait diverger personne d'autre. Ce qui ne change PAS: le dessin (`visualFor`), le
 * calcul du prix (`priceParts`), et l'annotation de part employé - c'est le CONTENU de la carte, la
 * même donnée que la caisse facture, seule l'enveloppe est neuve.
 *
 * ⚠ `dangerouslySetInnerHTML` est acceptable ICI pour une seule raison, la même que dans la caisse:
 * la chaîne rendue ne vient PAS de la base, elle vient d'une table FIGÉE du code
 * (`lib/business/art.ts`). `artKey` sert de CLÉ DE RECHERCHE, jamais de contenu, et une clé inconnue
 * retombe sur l'icône du rayon. C'est la distinction index contre contenu, celle qui manquait à la
 * palette avant le 2026-08-08. Elle ne tient que tant que personne ne rend ici une chaîne stockée:
 * ne jamais y faire passer `imageUrl` ni quoi que ce soit d'autre venu de `lifeinvader_business_items`.
 */
export function TileVisual({
  artKey,
  icon,
  ribbon,
}: {
  artKey: string | null;
  icon?: string;
  ribbon?: string;
}) {
  const v = visualFor(artKey, icon);
  return (
    <div
      className={cn(
        "relative grid h-[116px] place-items-center border-b border-border",
        // 72px pour un dessin d'article (matière pleine, se lit comme une vraie photo produit),
        // 36px attenué a 40% pour le repli sur l'icône du rayon: les deux valeurs sont celles
        // approuvées de la maquette (business.css `.tvis.art`/`.tvis.icon`), reprises telles quelles.
        v.kind === "art" ? "[&_svg]:size-[72px]" : "[&_svg]:size-9 [&_svg]:opacity-40",
      )}
      style={{ background: "var(--plate)", color: "var(--k, var(--fg))" }}
    >
      {/* Le SVG vit dans son propre noeud pour que le bandeau puisse cohabiter avec lui sans se
          faire écraser par le `dangerouslySetInnerHTML`, qui remplace TOUT l'intérieur de l'élément
          qui le porte. */}
      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: v.svg }} />
      {ribbon ? (
        // `variant="destructive"` et non une couleur choisie: `--destructive` reste rouge pour
        // TOUTE enseigne (voir `theme.ts` `shadcnBridge`), ce qui est plus juste que l'ancien
        // `#a32d1a` fixe - un "Archivé" doit rester lisible même sur une palette rouge/rose.
        <Badge
          variant="destructive"
          className="absolute top-1.5 right-1.5 rounded-sm px-1.5 py-0 text-[9px] font-bold tracking-wider uppercase"
        >
          {ribbon}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * UN ARTICLE, tel qu'il apparaîtra à la caisse, plus les annotations que seule la direction voit.
 *
 * ⚠ LA PART EMPLOYÉ EST ANNOTÉE, JAMAIS PRÉSENTÉE COMME UN PRIX. Elle ne sort pas de la facture du
 * client: c'est l'employeur qui la verse en fin de semaine. Elle porte donc son libellé en toutes
 * lettres et vit sous le prix, en petit, au lieu de former une seconde ligne de montant que l'oeil
 * lirait comme un tarif barré ou une remise.
 *
 * `showVisual` suit le module "Visuels produits" du commerce: quand il est éteint, la caisse ne
 * dessine aucune plaque, donc cette vignette n'en dessine pas non plus. Une page de gestion qui
 * montrerait un dessin que le client ne verra jamais mentirait sur son seul travail.
 */
export function ProductTile({
  label,
  priceCents,
  commissionCents,
  categoryLabel,
  tone,
  artKey,
  categoryIcon,
  showVisual,
  showCommission,
  archived = false,
  editing = false,
  actions,
}: {
  label: string;
  priceCents: number;
  commissionCents: number;
  categoryLabel: string;
  tone: number;
  artKey: string | null;
  categoryIcon?: string;
  showVisual: boolean;
  showCommission: boolean;
  archived?: boolean;
  editing?: boolean;
  actions?: React.ReactNode;
}) {
  const p = priceParts(priceCents);
  return (
    <Card
      data-slot="catalogue-product-tile"
      style={toneVars(tone) as React.CSSProperties}
      className={cn(
        "gap-0 overflow-hidden rounded-[var(--r)] py-0",
        // 0.42 est la valeur mesurée de la maquette (`.tile.dead`), reprise telle quelle plutôt
        // qu'arrondie à un cran Tailwind standard.
        archived && "opacity-[0.42]",
        // L'article OUVERT dans la fiche: `--brand`/`primary` et non le ton du rayon, parce que
        // "je suis en train de modifier ceci" est un état de l'INTERFACE, pas une propriété du
        // rayon - le peindre à la couleur du rayon le rendrait invisible dans son groupe.
        // ⚠ `ring`, pas `border`: `<Card>` n'a pas de largeur de bord par défaut (seulement un
        // `ring-1` d'un pixel), donc une simple `border-primary` n'aurait changé la couleur
        // d'AUCUN pixel visible. `ring-inset` reproduit l'ancien `outline … offset:-2px`.
        editing && "ring-2 ring-primary ring-inset",
      )}
    >
      {showVisual ? (
        <TileVisual artKey={artKey} icon={categoryIcon} ribbon={archived ? "Archivé" : undefined} />
      ) : null}
      <CardContent className="grid gap-1 px-2.5 py-2.5">
        <span
          className="min-w-0 truncate text-[9px] font-bold tracking-[0.14em] uppercase"
          style={{ color: "var(--kt, var(--fg))" }}
        >
          {categoryLabel}
        </span>
        {/* Un article en cours de création n'a pas encore de nom: on le dit, plutôt que de laisser
            une ligne vide qui ressemble à une vignette cassée. */}
        <span className="text-[13px] leading-snug font-semibold text-foreground">
          {label.trim() || "Nom de l'article"}
        </span>
        <span className="text-[25px] leading-[1.05] font-bold tracking-[-0.025em] text-foreground tabular-nums">
          {p.amount}
          <sup className="ml-0.5 align-super text-xs font-semibold">{p.symbol}</sup>
        </span>
        {/* ⚠ LE SIGNE PLUS EST LA MOITIÉ DU MESSAGE. "Part employé 12 $" posé sous un prix se lit
            comme un second tarif, donc comme une remise, ce qui est l'inversion exacte que le
            propriétaire a déjà eu à corriger. "+12 $ hors facture" dit dans le même souffle que
            l'argent S'AJOUTE et qu'il ne sort pas de la poche du client. */}
        {showCommission ? (
          <span className="text-[10px] text-muted-foreground">
            {commissionCents > 0 ? (
              <>
                <b className="font-bold tabular-nums text-[var(--ok)]">+{money(commissionCents)}</b>{" "}
                employé, hors facture
              </>
            ) : (
              "Aucune part employé"
            )}
          </span>
        ) : null}
      </CardContent>
      {actions ? (
        <CardFooter className="grid grid-cols-2 gap-0 divide-x divide-border border-t border-border p-0">
          {actions}
        </CardFooter>
      ) : null}
    </Card>
  );
}
