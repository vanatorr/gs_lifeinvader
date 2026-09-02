"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ItemRow } from "@/lib/business/catalogue";
import { CATEGORY_ICONS } from "@/lib/business/art";
import { money, toneVars } from "@/lib/business/theme";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import ItemEditor from "./ItemEditor";
import { ProductTile } from "./ProductTile";
import {
  artSuggestion,
  dollarsInt,
  draftFromRow,
  emptyDraft,
  previewCents,
  sameDraft,
  type Draft,
} from "./draft";
import {
  createItemAction,
  moveItemAction,
  setItemActiveAction,
  updateItemAction,
  type ItemFormInput,
} from "./actions";
import s from "./catalogue.module.css";

/**
 * La grille interne d'UN rayon (ou de la boîte archivés): deux colonnes à la largeur de carte
 * visée, reprise telle quelle de l'ancien `.rayonBody`/`.archiveGrid` (catalogue.module.css) au lieu
 * d'être réinventée - c'est la valeur mesurée qui rend le cas creux (neuf articles, quatre rayons)
 * régulier plutôt que troué. Partagée par les deux grilles pour qu'"en vente" et "archivés" se lisent
 * comme la même carte.
 *
 * ⚠ Le palier `max-[730px]` (140px au lieu de 180px) reprend lui aussi le seuil mesuré de l'ancien
 * `@media (max-width: 730px)` de catalogue.module.css: deux vignettes au pouce plutôt qu'une seule
 * géante, même règle que la caisse.
 */
const TILE_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(min(180px,100%),1fr))] gap-2.5 max-[730px]:grid-cols-[repeat(auto-fill,minmax(min(140px,100%),1fr))]";

type Category = { key: string; label: string; tone: number; icon?: string };

/** Quel article la fiche de droite tient en ce moment. `null` veut dire "aucune fiche ouverte". */
type Mode = { kind: "add"; category?: string } | { kind: "edit"; id: number };

/** Un rayon et ses articles, dans l'ordre d'affichage de la caisse. */
type Group = {
  key: string;
  label: string;
  tone: number;
  icon?: string;
  /** Le rayon est-il DÉCLARÉ dans les Réglages, ou seulement porté par de vieux articles. */
  declared: boolean;
  rows: ItemRow[];
  /** Combien d'articles EN VENTE ce rayon porte, filtres ignorés. Le filtre cache, il ne vide pas. */
  total: number;
  /** La fourchette de prix du rayon, sur les articles en vente. `null` quand il est vide. */
  range: { min: number; max: number } | null;
};

/**
 * LE CATALOGUE, CÔTÉ GESTION.
 *
 * ⚠⚠ CETTE PAGE A ÉTÉ REFAITE DEUX FOIS. Le 2026-08-08 d'abord, verdict du propriétaire: "the
 * catalogue page needs to be done wayy better its ui is ass, not user friendly and no way using
 * icons for each product that are premade like the ones in the html" - la carte était un TABLEAU et
 * `artKey` n'avait aucune interface. Puis le 2026-08-09, verdict sur toutes les pages sauf la
 * caisse: "not user friendly, not revolutionary UI, not easy to use. it too like liney line per
 * line". Ce qui restait à corriger ici n'était plus le tableau, c'était la COMPOSITION:
 *
 *   1. LE RAYON N'ÉTAIT PAS UNE SECTION, juste un titre au-dessus d'une grille. Il porte maintenant
 *      son icône (celle que le client voit en repli), sa couleur, ce qu'il contient, sa fourchette
 *      de prix, et le bouton qui le remplit. On arrange une carte rayon par rayon; le geste doit
 *      être là où on regarde, pas dans un bouton unique en haut de page.
 *   2. LES ARCHIVÉS SUIVAIENT LES RAYONS, donc à l'oeil ils étaient un rayon de plus, en plus pâle.
 *      Ils vivent dans leur propre boîte fermée, après un écart franc.
 *   3. LA PART EMPLOYÉ SE LISAIT COMME UN SECOND PRIX. Elle porte son signe `+` et la mention
 *      "hors facture" sur chaque vignette, et la légende du bas dit d'où sort l'argent.
 *   4. `itemArt.ts` NE SERVAIT À RIEN. 200 correspondances article du jeu vers dessin, 33 règles de
 *      repli sur le libellé français, et zéro appelant: taper `atomburger` proposait le hamburger
 *      dans le code et rien à l'écran. Voir `draft.ts` `artSuggestion` et le drapeau `artTouched`.
 *
 * ⚠ LE PALIER DE LECTURE ET LE PALIER D'ÉCRITURE SONT SÉPARÉS. `catalogue.read` suffit pour tout
 * VOIR (c'est la carte des prix, pas un secret, et elle est au palier "session"); `catalogue.write`
 * exige en plus d'être en service. Un grade qui peut lire mais pas écrire voit la carte ENTIÈRE,
 * boutons grisés et motif affiché, jamais une page vide qui laisserait croire à une panne.
 */
export default function CatalogueView({
  slug,
  name,
  canRead,
  readReason,
  canWrite,
  writeReason,
  items,
  categories,
  showCommission,
  showVisuals,
  payPanel,
}: {
  slug: string;
  name: string;
  canRead: boolean;
  /** Pourquoi la page est fermée. Rempli seulement quand `canRead` est faux. */
  readReason: string | null;
  canWrite: boolean;
  /** Pourquoi l'écriture est fermée. Rempli seulement quand `canWrite` est faux. */
  writeReason: string | null;
  items: ItemRow[];
  categories: Category[];
  showCommission: boolean;
  showVisuals: boolean;
  /**
   * Le panneau de part employé, rendu sous le catalogue.
   *
   * ⚠ PASSÉ EN EMPLACEMENT PLUTÔT QU'IMPORTÉ ICI, pour que la page reste le seul endroit qui décide
   * si ce panneau existe et avec quelles données. Cet écran est déjà le plus gros du portail; y
   * brancher une seconde source de données (l'effectif du métier, la politique du commerce)
   * l'obligerait à connaître des choses qu'il n'affiche pas.
   */
  payPanel?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(""));
  /** L'état du brouillon au moment de son ouverture: la seule référence honnête pour "non enregistré". */
  const [baseline, setBaseline] = useState<Draft>(() => emptyDraft(""));
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** La fiche que l'on essaie d'ouvrir alors que la courante a des changements en attente. */
  const [wanted, setWanted] = useState<Mode | null>(null);

  const [catFilter, setCatFilter] = useState<string>("*");
  const [q, setQ] = useState("");
  const [onlyBare, setOnlyBare] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const dirty = mode !== null && !sameDraft(draft, baseline);

  /* ── Ce que la page compte, avant tout filtre ─────────────────────────────────────────────── */

  const active = useMemo(() => items.filter((i) => i.active), [items]);
  const archived = useMemo(() => items.filter((i) => !i.active), [items]);
  const bareCount = useMemo(() => active.filter((i) => !i.artKey).length, [active]);
  const usedCategories = useMemo(() => new Set(active.map((i) => i.category)).size, [active]);

  /* ── Filtres ──────────────────────────────────────────────────────────────────────────────── */

  const filtering = catFilter !== "*" || q.trim().length > 0 || onlyBare;

  const keep = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (it: ItemRow) =>
      (catFilter === "*" || it.category === catFilter) &&
      (!needle || it.label.toLowerCase().includes(needle)) &&
      (!onlyBare || !it.artKey);
  }, [catFilter, q, onlyBare]);

  /**
   * LES GROUPES, DANS L'ORDRE DES RAYONS DÉCLARÉS.
   *
   * ⚠ Un article dont le rayon n'est PLUS déclaré (rayon renommé à la main en base, données
   * antérieures) reçoit quand même son groupe, marqué comme inconnu. Le laisser tomber le rendrait
   * invisible ici tout en le laissant vendable par son identifiant, ce qui est la pire des deux
   * situations: personne ne saurait qu'il faut le reclasser.
   *
   * ⚠ `total` ET `range` SE CALCULENT AVANT LE FILTRE, `rows` APRÈS. Un en-tête de rayon qui
   * annoncerait "1 article, 4 $" parce qu'une recherche est en cours mentirait sur la carte: le
   * filtre CACHE des articles, il n'en retire aucun de la vente.
   */
  const groups = useMemo<Group[]>(() => {
    const out: Group[] = categories.map((c) => ({
      key: c.key,
      label: c.label,
      tone: c.tone,
      icon: c.icon,
      declared: true,
      rows: [],
      total: 0,
      range: null,
    }));
    const index = new Map(out.map((g) => [g.key, g]));

    const bump = (it: ItemRow) => {
      let g = index.get(it.category);
      if (!g) {
        g = {
          key: it.category,
          label: it.category,
          tone: 1,
          declared: false,
          rows: [],
          total: 0,
          range: null,
        };
        index.set(it.category, g);
        out.push(g);
      }
      g.total += 1;
      g.range = g.range
        ? { min: Math.min(g.range.min, it.priceCents), max: Math.max(g.range.max, it.priceCents) }
        : { min: it.priceCents, max: it.priceCents };
      if (keep(it)) g.rows.push(it);
      return g;
    };

    for (const it of active) bump(it);
    return out;
  }, [categories, active, keep]);

  const archivedShown = useMemo(() => archived.filter(keep), [archived, keep]);
  const shownCount = groups.reduce((n, g) => n + g.rows.length, 0);

  const categoryOf = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c]));
    return (key: string) => m.get(key);
  }, [categories]);

  /* ── Ouvrir, fermer, abandonner ───────────────────────────────────────────────────────────── */

  function applyMode(next: Mode | null) {
    setWanted(null);
    setError(null);
    setFlash(null);
    setMode(next);
    if (!next) return;
    const fresh =
      next.kind === "add"
        ? emptyDraft(next.category ?? categories[0]?.key ?? "")
        : (() => {
            const row = items.find((i) => i.id === next.id);
            return row ? draftFromRow(row) : emptyDraft(categories[0]?.key ?? "");
          })();
    setDraft(fresh);
    setBaseline(fresh);
  }

  /**
   * ⚠ ON NE JETTE PAS UNE SAISIE EN COURS SUR UN CLIC DE TRAVERS, et on ne bloque pas non plus. Un
   * clic ailleurs pendant qu'un prix est à moitié tapé demande confirmation EN UNE PHRASE, avec les
   * deux sorties côte à côte. Perdre trois minutes de tarifs parce qu'on a visé une vignette voisine
   * serait exactement le genre de détail qui fait dire "not user friendly".
   */
  function request(next: Mode | null) {
    if (dirty && next !== null) {
      setWanted(next);
      return;
    }
    applyMode(next);
  }

  /**
   * ⚠⚠ LA PRÉ-SÉLECTION DU DESSIN PASSE PAR ICI, ET PAR NULLE PART AILLEURS.
   *
   * Taper un nom d'article du jeu (`atomburger`) ou un libellé que `itemArt.ts` sait lire ("Verre de
   * rouge") pose le bon dessin tout seul. Mais SEULEMENT tant que `artTouched` est faux, c'est-à-dire
   * sur une fiche neuve où il n'y a rien à écraser. Dès qu'une personne a choisi un dessin à la main,
   * ou dès qu'on ouvre un article existant (dont la valeur en base EST un choix, `null` compris), la
   * proposition ne s'applique plus toute seule: elle s'affiche dans la fiche et s'accepte d'un clic.
   *
   * Le drapeau vit dans le brouillon plutôt que dans un `if` posé au bon endroit: c'est ce qui fait
   * qu'un futur appelant qui modifierait le libellé ne peut PAS effacer un dessin choisi, même en
   * l'ignorant complètement.
   */
  function patchDraft(patch: Partial<Draft>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.label !== undefined && !next.artTouched) {
        next.artKey = artSuggestion(next.label);
      }
      return next;
    });
  }

  /* ── Écritures ────────────────────────────────────────────────────────────────────────────── */

  function payload(price: number, commission: number): ItemFormInput {
    return {
      label: draft.label.trim(),
      category: draft.category,
      // Le navigateur envoie des DOLLARS; la conversion en centimes appartient à `actions.ts`.
      priceDollars: price,
      commissionDollars: commission,
      artKey: draft.artKey,
    };
  }

  /**
   * ⚠ CE CONTRÔLE EST UN CONFORT, PAS UNE BARRIÈRE. Le serveur revalide tout (`validateItem`), et
   * c'est lui qui décide. Il existe pour deux raisons: éviter un aller-retour pour un champ vide, et
   * surtout ne pas laisser une saisie illisible partir en `NaN`, que la sérialisation d'un Server
   * Action transforme en `null`, donc en `0` côté serveur. Un article gratuit créé par une faute de
   * frappe ne doit dépendre d'aucun détail de sérialisation.
   */
  function save() {
    if (!mode || pending || !canWrite) return;

    if (draft.label.trim().length === 0) {
      setError("Donnez un nom à l'article avant d'enregistrer.");
      return;
    }
    const price = dollarsInt(draft.price);
    if (!Number.isFinite(price) || price < 0) {
      setError("Le prix client doit être un nombre entier de dollars, à partir de 0.");
      return;
    }
    const commission = showCommission ? dollarsInt(draft.commission) : 0;
    if (!Number.isFinite(commission) || commission < 0) {
      setError("La part employé doit être un nombre entier de dollars, à partir de 0.");
      return;
    }

    const current = mode;
    const sent = draft;
    start(async () => {
      const res =
        current.kind === "add"
          ? await createItemAction(slug, payload(price, commission))
          : await updateItemAction(slug, current.id, payload(price, commission));
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setError(null);
      if (current.kind === "add") {
        // On ne récupère pas l'identifiant du nouvel article: la fiche se ferme et le dit, plutôt que
        // de rester ouverte sur un article qu'elle ne saurait pas relire.
        setMode(null);
        setFlash(`Article créé: ${sent.label.trim() || "sans nom"}.`);
      } else {
        // La saisie devient la nouvelle référence: le bandeau "non enregistré" doit s'éteindre.
        setBaseline(sent);
        setFlash(null);
      }
      router.refresh();
    });
  }

  function toggleActive(row: ItemRow) {
    if (pending || !canWrite) return;
    start(async () => {
      const res = await setItemActiveAction(slug, row.id, !row.active);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  function move(dir: "up" | "down") {
    if (!mode || mode.kind !== "edit" || pending || !canWrite) return;
    const id = mode.id;
    start(async () => {
      const res = await moveItemAction(slug, id, dir);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  /* ── Voisinage du rangement, pour griser les bons boutons ─────────────────────────────────── */

  const neighbours = useMemo(() => {
    if (!mode || mode.kind !== "edit") return { up: false, down: false };
    const me = items.find((i) => i.id === mode.id);
    if (!me) return { up: false, down: false };
    // Le même voisinage que celui appliqué côté serveur (`moveItemAction`): même rayon, même état.
    // Les deux doivent s'accorder, sinon un bouton actif ne ferait rien, ou un bouton grisé cacherait
    // un déplacement possible.
    const peers = items.filter((i) => i.category === me.category && i.active === me.active);
    const at = peers.findIndex((i) => i.id === me.id);
    return { up: at > 0, down: at >= 0 && at < peers.length - 1 };
  }, [items, mode]);

  /* ── Page fermée ──────────────────────────────────────────────────────────────────────────── */

  if (!canRead) {
    return (
      <>
        <div className="head">
          <h1>Catalogue</h1>
          <span className="sub">{name}</span>
        </div>
        <div className="panel">
          <p className="pick">{readReason ?? "Vous n'avez pas accès au catalogue de cette entreprise."}</p>
        </div>
      </>
    );
  }

  /* ── Une vignette de la carte ─────────────────────────────────────────────────────────────── */

  function tileFor(row: ItemRow, groupTone: number, groupLabel: string, groupIcon?: string) {
    const editing = mode?.kind === "edit" && mode.id === row.id;
    // ⚠ La vignette de l'article OUVERT montre le BROUILLON, pas la base: c'est ce qui fait que le
    // prix et le dessin bougent pendant qu'on tape, à l'endroit même où on les regarde.
    const shown = editing
      ? {
          label: draft.label,
          priceCents: previewCents(draft.price),
          commissionCents: previewCents(draft.commission),
          artKey: draft.artKey,
          category: draft.category,
        }
      : {
          label: row.label,
          priceCents: row.priceCents,
          commissionCents: row.commissionCents,
          artKey: row.artKey,
          category: row.category,
        };
    const cat = categoryOf(shown.category);
    return (
      <ProductTile
        key={row.id}
        label={shown.label}
        priceCents={shown.priceCents}
        commissionCents={shown.commissionCents}
        categoryLabel={cat?.label ?? groupLabel}
        tone={cat?.tone ?? groupTone}
        artKey={shown.artKey}
        categoryIcon={cat?.icon ?? groupIcon}
        showVisual={showVisuals}
        showCommission={showCommission}
        archived={!row.active}
        editing={editing}
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              className={cn(
                "h-8 w-full rounded-none text-xs",
                editing && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
              )}
              onClick={() => request({ kind: "edit", id: row.id })}
            >
              {canWrite ? "Modifier" : "Voir la fiche"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-8 w-full rounded-none text-xs"
              disabled={!canWrite || pending}
              title={!canWrite && writeReason ? writeReason : undefined}
              onClick={() => toggleActive(row)}
            >
              {row.active ? "Archiver" : "Remettre en vente"}
            </Button>
          </>
        }
      />
    );
  }

  /* ── Une carte de rayon ───────────────────────────────────────────────────────────────────── */

  /**
   * UN RAYON EST UNE CARTE shadcn, PAS UNE BANDE.
   *
   * ⚠⚠ C'EST LA CORRECTION DU 2026-08-09, et elle est mesurée. La coquille plafonne le contenu à
   * 1360px, donc la colonne des articles fait 1018px sur un écran de 1990px. En bande pleine
   * largeur, un rayon étalait ses articles sur CINQ colonnes; ce commerce en vend neuf répartis sur
   * quatre rayons, soit deux à trois par rayon, et chaque bande était donc à moitié vide sur toute
   * la largeur de l'écran. Verdict du propriétaire: "space isnt used correctly", et des hauteurs
   * qui ne se répondent pas. `s.rayonGrid` (inchangée, voir catalogue.module.css) reste la grille
   * EXTÉRIEURE qui pave les cartes de rayon; c'est SEULEMENT l'intérieur d'une carte (l'en-tête, la
   * grille d'articles, le vide) qui passe à `<Card>` + Tailwind ci-dessous.
   *
   * En carte, la grille interne est étroite (deux colonnes), donc deux articles la REMPLISSENT, et
   * quatre rayons pavent la surface en carré 2x2. Les cartes d'une même rangée de grille CSS
   * s'étirent à la même hauteur par construction: leurs bas se rejoignent sans qu'aucun contenu
   * n'ait à être de la même longueur.
   */
  function rayonCard(g: Group) {
    // Le dessin exact qu'un article sans illustration prendra dans ce rayon: le même repli que
    // `visualFor`, donc l'en-tête montre ce que le client verra, jamais une icône décorative.
    // ⚠ `dangerouslySetInnerHTML` acceptable pour la même unique raison que dans la vignette et la
    // caisse: la chaîne vient d'une table FIGÉE du code (`lib/business/art.ts`), et `g.icon`, qui
    // vient de la base, ne sert que de CLÉ de recherche. Index contre contenu. Ne jamais y faire
    // passer une chaîne stockée.
    const icon = (g.icon && CATEGORY_ICONS[g.icon]) || CATEGORY_ICONS.box || "";
    const toneStyle = toneVars(g.tone) as React.CSSProperties;
    return (
      <Card
        key={g.key}
        style={toneStyle}
        className={cn(
          "gap-0 overflow-hidden rounded-[var(--r)] py-0",
          // Le rayon qu'aucun réglage ne déclare: son bord dit qu'il y a quelque chose à réparer,
          // avant même d'avoir lu l'encart. `border` explicite: `<Card>` n'a par défaut qu'un
          // `ring-1` d'un pixel, pas de largeur de bordure - sans `border`, `border-[var(--warn)]`
          // ne changerait la couleur d'aucun pixel visible.
          !g.declared && "border border-[var(--warn)]",
        )}
      >
        <div className="flex min-h-10 flex-wrap items-center gap-2.5 border-b border-border px-2.5 py-2">
          {showVisuals ? (
            <span
              className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r)] border border-border [&>svg]:size-4"
              style={{ background: "var(--plate)", color: "var(--k, var(--fg))" }}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: icon }}
            />
          ) : null}
          {/* `--kt` et non `--k`: c'est du TEXTE, et la teinte de remplissage est illisible en
              lettres sur le fond du panneau. */}
          <span
            className="min-w-0 flex-none text-[10px] font-bold tracking-[0.16em] uppercase [overflow-wrap:anywhere]"
            style={{ color: "var(--kt, var(--fg))" }}
          >
            {g.label}
          </span>
          <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
            {g.range
              ? g.range.min === g.range.max
                ? money(g.range.min)
                : `${money(g.range.min)} à ${money(g.range.max)}`
              : "aucun prix"}
          </span>
          <span className="flex-1" />
          <Badge variant="secondary" className="shrink-0">
            {filtering && g.rows.length !== g.total
              ? `${g.rows.length} sur ${g.total}`
              : `${g.total} article${g.total > 1 ? "s" : ""}`}
          </Badge>
        </div>

        {!g.declared ? (
          <div className="p-3">
            <div className="note hot">
              <strong>Rayon inconnu.</strong> Aucun rayon nommé « {g.key} » n&apos;est déclaré dans
              les Réglages, donc ces articles n&apos;apparaissent sous aucune puce à la caisse.
              Reclassez-les, ou recréez ce rayon depuis les Réglages.
            </div>
          </div>
        ) : null}

        <div className={cn(TILE_GRID, "flex-1 content-start p-2.5")}>
          {g.rows.length === 0 ? (
            <Empty className="col-span-full gap-2 p-3">
              <EmptyHeader className="gap-1.5">
                {showVisuals ? (
                  <EmptyMedia variant="icon" className="[&>span>svg]:size-4">
                    <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
                  </EmptyMedia>
                ) : null}
                <EmptyTitle className="text-xs">{filtering ? "Aucun résultat" : "Rayon vide"}</EmptyTitle>
                <EmptyDescription className="text-[11px]">
                  {filtering
                    ? "Aucun article de ce rayon ne correspond au filtre."
                    : "Ce rayon est déclaré mais vide. Il apparaît quand même à la caisse, sans rien dessous."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            g.rows.map((row) => tileFor(row, g.tone, g.label, g.icon))
          )}

          {/* LA CASE "AJOUTER", dernière vignette du rayon. Elle n'est pas décorative: elle est ce
              qui fait qu'un rayon de deux articles remplit sa rangée au lieu de la laisser courte,
              et elle pose le geste là où on regarde plutôt que dans un bouton unique en haut de
              page. Retirée quand un filtre est posé: on ne crée pas un article dans une vue
              partielle, la carte qu'on voit n'est pas la carte réelle. Pas un `<Button>` shadcn: le
              pointillé est la métaphore ("en cours d'écriture") que le propriétaire a validée, et
              aucune variante de bouton shadcn ne la porte. */}
          {g.declared && !filtering ? (
            <button
              type="button"
              className="grid min-h-[172px] place-items-center gap-1.5 rounded-[var(--r)] border border-dashed border-border p-3 text-center text-[11px] font-semibold text-muted-foreground hover:border-primary hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 max-[730px]:min-h-[140px]"
              disabled={!canWrite || pending}
              title={!canWrite && writeReason ? writeReason : `Ajouter un article dans ${g.label}`}
              onClick={() => request({ kind: "add", category: g.key })}
            >
              <span className="text-xl leading-none font-bold" aria-hidden="true">
                +
              </span>
              <span>Ajouter dans {g.label}</span>
            </button>
          ) : null}
        </div>
      </Card>
    );
  }

  /* ── Rendu ────────────────────────────────────────────────────────────────────────────────── */

  return (
    <>
      <div className="head">
        <h1>Catalogue</h1>
        <span className="sub">{name}</span>
        <span className="spacer" />
        <button
          className={`btn ${s.btnAuto}`}
          disabled={!canWrite}
          onClick={() => request({ kind: "add" })}
        >
          Ajouter un article
        </button>
      </div>

      {!canWrite ? (
        <div className="note hot">
          <strong>Modification verrouillée.</strong>{" "}
          {writeReason ?? "La prise de service est requise pour changer un prix ou un article."} La
          carte reste consultable en entier.
        </div>
      ) : null}

      <div className="figs">
        <div className="fig">
          <div className="k cap">Articles en vente</div>
          <div className="v lead">{active.length}</div>
          <div className="m">visibles à la caisse</div>
        </div>
        <div className="fig">
          <div className="k cap">Sans illustration</div>
          <div className="v">{bareCount}</div>
          <div className="m">
            {bareCount > 0 ? "vignette réduite à l'icône du rayon" : "toute la carte est illustrée"}
          </div>
        </div>
        <div className="fig">
          <div className="k cap">Rayons</div>
          <div className="v">{categories.length}</div>
          <div className="m">{usedCategories} avec au moins un article</div>
        </div>
        <div className="fig">
          <div className="k cap">Archivés</div>
          <div className="v">{archived.length}</div>
          <div className="m">retirés de la caisse, jamais supprimés</div>
        </div>
      </div>

      {/* ⚠ LA COMPOSITION EST UNE RANGÉE DE DEUX COLONNES QUI S'ÉTIRENT, pas une pile de bandes.
          `align-items: stretch` fait que la fiche de droite a exactement la hauteur de la colonne
          de gauche, donc elle ne pend plus à mi-page; `min-height` fait que cette rangée atteint le
          bas de la fenêtre même quand le commerce n'a presque rien à vendre, donc la page ne
          s'arrête plus aux deux tiers en laissant un vide dessous. Voir catalogue.module.css. */}
      <div className={s.work}>
        <div className={s.boardCol}>
          <div className="tools">
            <div className="cats">
              <button
                className={`chip ${s.chipPlain}`}
                aria-pressed={catFilter === "*"}
                onClick={() => setCatFilter("*")}
              >
                Tout
              </button>
              {categories.map((c) => (
                <button
                  key={c.key}
                  className="chip"
                  aria-pressed={catFilter === c.key}
                  style={toneVars(c.tone) as React.CSSProperties}
                  onClick={() => setCatFilter(c.key)}
                >
                  <i />
                  {c.label}
                </button>
              ))}
              {/* Le raccourci qui répond à la demande du propriétaire: trouver d'un clic tout ce qui
                  n'a pas encore de dessin, au lieu de parcourir la carte à l'oeil.
                  ⚠ Il ne se grise JAMAIS pendant qu'il est actif. Griser le filtre au moment où son
                  compte tombe à zéro (c'est-à-dire quand on vient d'illustrer le dernier article)
                  enfermerait la personne sur une carte vide, sans le bouton qui l'en sort. */}
              <button
                className={`chip ${s.chipPlain}`}
                aria-pressed={onlyBare}
                disabled={bareCount === 0 && !onlyBare}
                onClick={() => setOnlyBare((v) => !v)}
              >
                Sans illustration ({bareCount})
              </button>
            </div>
            <input
              className="search"
              placeholder="Rechercher un article"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {items.length === 0 && categories.length === 0 ? (
            <div className="panel">
              <p className="pick">
                Ce commerce n&apos;a ni rayon ni article. Créez d&apos;abord un rayon depuis les
                Réglages: c&apos;est lui qui donne à un article sa couleur et son groupe à la caisse.
              </p>
            </div>
          ) : shownCount === 0 && archivedShown.length === 0 && filtering ? (
            // Le motif nomme le filtre RESPONSABLE, pas "un filtre" en général: la sortie doit être
            // le bouton sur lequel on vient de cliquer, pas une devinette parmi les trois.
            <div className="note">
              {onlyBare && bareCount === 0
                ? "Tous les articles en vente ont désormais une illustration. Décochez « Sans illustration » pour revoir la carte entière."
                : "Aucun article ne correspond. Videz la recherche, reprenez le rayon « Tout », ou décochez « Sans illustration »."}
            </div>
          ) : null}

          {/* ⚠ UN RAYON DÉCLARÉ MAIS VIDE RESTE VISIBLE quand on regarde la carte entière, et c'est
              délibéré: c'est le cas du commerce qui démarre, et sa carte doit montrer les quatre
              étagères à remplir plutôt qu'un écran vide. Il ne disparaît que sous filtre, où il
              serait du bruit. */}
          <div className={s.rayonGrid}>
            {groups.map((g) => {
              if (g.rows.length === 0 && (filtering || !g.declared)) return null;
              return rayonCard(g);
            })}
          </div>

          {/* LES ARCHIVÉS, DANS LEUR PROPRE BOÎTE, ET EN BAS DE COLONNE. Ce ne sont pas un rayon de
              plus: ils sont hors de la carte. Repliés, ils tiennent en une barre d'en-tête, et la
              grille des rayons prend toute la place au-dessus: l'espace libre d'une carte peu
              fournie devient donc un écart borné en haut et en bas, au lieu d'un fond de page qui
              s'arrête. */}
          {archived.length > 0 ? (
            <Card className="gap-0 overflow-hidden rounded-[var(--r)] py-0">
              <div className="flex items-center justify-between gap-2.5 border-b border-border px-3 py-2 text-muted-foreground">
                <span className="cap">Archivés</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowArchived((v) => !v)}>
                  {showArchived ? "Masquer" : `Afficher (${archived.length})`}
                </Button>
              </div>
              {showArchived ? (
                <div className="p-3">
                  <p className="mb-2.5 text-[11px] text-muted-foreground">
                    Retirés de la caisse, jamais supprimés: les ventes déjà déclarées pointent encore
                    ces articles. Remettre en vente les fait réapparaître dans leur rayon.
                  </p>
                  {archivedShown.length === 0 ? (
                    <div className="note">Aucun article archivé ne correspond à ce filtre.</div>
                  ) : (
                    <div className={TILE_GRID}>
                      {archivedShown.map((row) => {
                        const c = categoryOf(row.category);
                        return tileFor(row, c?.tone ?? 1, c?.label ?? row.category, c?.icon);
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <aside className={s.editorCol}>
          {wanted ? (
            <div className="note hot">
              <strong>Modifications non enregistrées.</strong> Enregistrez la fiche ouverte, ou
              abandonnez-la pour ouvrir l&apos;autre article.
              <div className={`edmore ${s.noteActs}`}>
                <button className="chip" onClick={() => applyMode(wanted)}>
                  Abandonner et ouvrir
                </button>
                <button className="chip" onClick={() => setWanted(null)}>
                  Rester sur cette fiche
                </button>
              </div>
            </div>
          ) : null}

          {mode ? (
            <ItemEditor
              mode={mode.kind}
              draft={draft}
              onChange={patchDraft}
              categories={categories}
              showCommission={showCommission}
              showVisuals={showVisuals}
              canWrite={canWrite}
              writeReason={writeReason}
              pending={pending}
              dirty={dirty}
              error={error}
              archived={mode.kind === "edit" && items.find((i) => i.id === mode.id)?.active === false}
              canMoveUp={neighbours.up}
              canMoveDown={neighbours.down}
              onSave={save}
              onCancel={() => applyMode(null)}
              onToggleActive={() => {
                const row = mode.kind === "edit" ? items.find((i) => i.id === mode.id) : undefined;
                if (row) toggleActive(row);
              }}
              onMove={move}
            />
          ) : (
            <Card className={cn(s.edPanel, "gap-0 overflow-hidden rounded-[var(--r)] py-0")}>
              <div className="ph">
                <span className="cap">Fiche article</span>
              </div>
              <div className="edbody">
                {flash ? <div className="note">{flash}</div> : null}
                {error ? <span className="gate">{error}</span> : null}
                <p className="pick">
                  Choisissez une vignette pour changer son nom, son prix, sa part employé ou son
                  dessin. Un article à la fois, et la vignette se redessine pendant que vous tapez.
                </p>
                <button className="btn" disabled={!canWrite} onClick={() => request({ kind: "add" })}>
                  Ajouter un article
                </button>
                {!canWrite && writeReason ? <span className="gate">{writeReason}</span> : null}
              </div>
            </Card>
          )}
        </aside>
      </div>

      {payPanel ? <div className="mt-4">{payPanel}</div> : null}

      {showCommission ? (
        <div className={s.legend}>
          <span>
            <strong>La part employé n&apos;est pas une remise.</strong> Sur chaque vignette elle
            s&apos;écrit <b>+ montant</b>, hors facture: le client paie le prix affiché, sans rien en
            déduire, et c&apos;est la société qui verse la part à l&apos;employé en fin de semaine.
            Elle peut dépasser le prix client sans que ce soit une erreur. Le total dû par employé se
            lit sur la page Équipe.
          </span>
        </div>
      ) : null}
      <p className="foot">
        Un article archivé disparaît de la caisse mais reste attaché aux ventes déjà déclarées: il
        n&apos;est jamais supprimé, seulement retiré de la vente. Les dessins sont fournis avec le
        portail, il n&apos;y a rien à téléverser.
      </p>
    </>
  );
}
