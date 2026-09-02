"use client";

import { useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronsUpDownIcon } from "lucide-react";
import { ART_KEYS, CATEGORY_ICONS, PRODUCT_ART } from "@/lib/business/art";
import { toneVars } from "@/lib/business/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { Popover, PopoverTrigger } from "@/components/ui/popover";

/**
 * LE SÉLECTEUR D'ILLUSTRATION: la bibliothèque de dessins, montrée comme des dessins, dans un
 * `Popover` + `Command` shadcn qu'on ouvre plutôt qu'une grille toujours dépliée.
 *
 * ⚠⚠ C'EST LE MANQUE QUE LE PROPRIÉTAIRE A SIGNALÉ EN PREMIER (2026-08-08). La bibliothèque existait
 * depuis le début (`lib/business/art.ts`, alimentée par la maquette approuvée) et la caisse la
 * rendait déjà, mais AUCUNE interface ne permettait d'en choisir une. Le champ est de première
 * classe dans le brouillon et voyage à chaque enregistrement (voir `draft.ts`).
 *
 * ⚠ LA LISTE N'EST JAMAIS ÉCRITE ICI. On parcourt `ART_KEYS` au rendu, donc toute clé ajoutée à
 * `art.ts` apparaît dans le sélecteur sans qu'une seule ligne de ce fichier change.
 *
 * ⚠ PAS DE TABLE DE LIBELLÉS FRANÇAIS, ET C'EST DÉLIBÉRÉ. La clé est humanisée mécaniquement
 * ("wineRed" donne "wine red") pour la recherche et pour le lecteur d'écran, et le CHOIX se fait sur
 * le dessin, qui est la seule chose que la personne regarde vraiment.
 *
 * ⚠⚠ POURQUOI `Command` GARDE UNE GRILLE D'ICÔNES ET NON SA LISTE VERTICALE PAR DÉFAUT. La demande du
 * propriétaire ("no way using icons for each product") portait sur le fait de choisir UN DESSIN EN LE
 * REGARDANT, pas de taper une clé à la main. Un `<CommandItem>` texte par ligne aurait réintroduit
 * exactement ce qui manquait: un champ où l'on tape "wineRed" au lieu de reconnaître le verre. La
 * recherche de `cmdk` reste utilisée (elle filtre plus vite qu'un simple `includes`), mais chaque
 * résultat s'affiche comme une case d'icône dans une grille, jamais comme une ligne de texte.
 *
 * ⚠⚠ LE `Popover` DOIT PORTER SON PROPRE `container`, DANS LE SOUS-ARBRE `[data-biz]`. `PopoverContent`
 * de `@/components/ui/popover` portale par défaut dans `document.body`, HORS du `<div data-biz="slug">`
 * posé par `[slug]/layout.tsx`. Or c'est CE conteneur qui porte le pont shadcn de `theme.ts`
 * (`--primary`, `--card`, `--border`, …): en dehors de lui, ces jetons retombent sur le thème PAR
 * DÉFAUT de CITADEL (`globals.css` `:root`, le vin du panneau staff), pas sur la couleur de CETTE
 * enseigne. Une supérette verte ou un garage orange verrait donc un sélecteur de dessin teinté vin,
 * silencieusement, sur toute page autre que vigneron. `ScopedPopoverContent` ci-dessous est une copie
 * volontaire de `PopoverContent` (pas une modification du fichier partagé, qui doit continuer à
 * portaler dans `document.body` pour le panneau staff) avec un `container` pointé sur un noeud DÉJÀ
 * dans le sous-arbre `[data-biz]`. Tout futur `Popover`/`Dialog`/`Sheet` shadcn ajouté au portail
 * commerce doit reprendre ce même correctif, pas juste celui-ci.
 */

/** "wineRed" donne "wine red", "bottleWine2" donne "bottle wine 2". Purement mécanique. */
function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

/** Minuscules sans accents: la recherche doit répondre à "epee" comme à "épée". */
function fold(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    // U+0300 a U+036F: les diacritiques une fois decomposes par NFD, en echappement explicite
    // (jamais un caractere combinant litteral dans le source, il dependrait de l'encodage du fichier).
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
}

/** Clé de repli pour "aucune illustration": ne collisionne avec aucune vraie clé (toutes camelCase). */
const NONE_VALUE = "__none__";

/**
 * Le même filtre "chaque mot tapé doit être présent" que l'ancienne grille, rebranché sur l'API de
 * `cmdk` (`value` + `keywords`) au lieu du tableau `shown` calculé à la main. `NONE_VALUE` répond
 * toujours présent: la case "aucune illustration" doit rester atteignable même sous un filtre, comme
 * avant (elle vivait hors de la liste filtrée).
 */
function artFilter(value: string, search: string, keywords?: string[]): number {
  if (value === NONE_VALUE) return 1;
  const needle = fold(search.trim());
  if (!needle) return 1;
  const words = needle.split(/\s+/);
  const hay = fold(`${value} ${(keywords ?? []).join(" ")}`);
  return words.every((w) => hay.includes(w)) ? 1 : 0;
}

/** Copie volontaire de `PopoverContent`, voir le commentaire de tête: seul le `container` change. */
function ScopedPopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  container,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  container?: HTMLElement | null;
}) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-[360px] max-w-[calc(100vw-2rem)] origin-(--radix-popover-content-transform-origin) flex-col gap-0 overflow-hidden rounded-[var(--r)] border border-border bg-popover p-0 text-sm text-popover-foreground shadow-[0_8px_22px_rgba(0,0,0,0.35)] outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export default function ArtPicker({
  value,
  onChange,
  categoryIcon,
  tone,
  disabled,
  suggestion,
  suggestionApplied,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  /** L'icône du rayon choisi: c'est le repli réel, donc c'est lui qu'on montre sur "aucune". */
  categoryIcon?: string;
  tone: number;
  disabled: boolean;
  /**
   * Le dessin que le nom tapé suggère (`draft.ts` `artSuggestion`), ou null quand le portail ne
   * sait pas. Il n'est jamais appliqué depuis ce composant: la vue décide, ce fichier montre.
   */
  suggestion: string | null;
  /** La valeur courante VIENT de la proposition, personne n'a encore choisi à la main. */
  suggestionApplied: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Une entrée par clé, avec son libellé humanisé, calculée une fois. */
  const entries = useMemo(() => ART_KEYS.map((key) => ({ key, human: humanize(key) })), []);

  const toneStyle = toneVars(tone) as React.CSSProperties;
  const fallbackIcon = (categoryIcon && CATEGORY_ICONS[categoryIcon]) || CATEGORY_ICONS.box || "";
  const suggestedSvg = suggestion ? (PRODUCT_ART[suggestion] ?? null) : null;
  const chosenSvg = value ? (PRODUCT_ART[value] ?? null) : null;

  const cell =
    "grid size-[52px] shrink-0 place-items-center rounded-[var(--r)] border border-border outline-none " +
    "data-[selected=true]:border-ring data-[selected=true]:ring-2 data-[selected=true]:ring-ring/40 " +
    "data-[picked=true]:border-primary data-[picked=true]:ring-2 data-[picked=true]:ring-primary";

  return (
    <div className="fld" ref={rootRef}>
      <span>
        Illustration
        <em>
          {value
            ? `Choisie: ${humanize(value)}`
            : "Aucune: la vignette prend l'icône du rayon, en plus petit et atténuée."}
        </em>
      </span>

      {/* LA PROPOSITION. Elle n'apparaît que quand le portail RECONNAÎT ce qui est tapé: un nom
          d'article du jeu (`atomburger`) ou un libellé français que `itemArt.ts` sait lire ("Verre
          de rouge"). Elle est montrée même une fois appliquée, parce qu'un dessin qui se pose tout
          seul dans l'aperçu sans que rien ne l'explique se lit comme un bug. */}
      {suggestedSvg ? (
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-[var(--r)] border border-border p-2",
            suggestionApplied && value === suggestion && "border-[var(--ok)]",
          )}
        >
          <span
            className="grid size-11 shrink-0 place-items-center rounded-[var(--r)] border border-border [&>svg]:size-[30px]"
            style={{ background: "var(--plate)", color: "var(--k, var(--fg))", ...toneStyle }}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: suggestedSvg }}
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <b className="text-sm font-semibold">
              {suggestionApplied && value === suggestion
                ? "Dessin proposé, déjà appliqué"
                : `Proposition: ${humanize(suggestion!)}`}
            </b>
            <em className="text-[10px] leading-[1.35] text-muted-foreground not-italic">
              {suggestionApplied && value === suggestion
                ? "Reconnu d'après le nom de l'article. Choisissez un autre dessin ci-dessous pour le remplacer."
                : "Reconnu d'après le nom de l'article, dans la table des produits du jeu."}
            </em>
          </span>
          {value === suggestion ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(suggestion)}
            >
              Utiliser
            </Button>
          )}
        </div>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            style={toneStyle}
            className="h-auto w-full justify-between gap-2 rounded-[var(--r)] px-2.5 py-2 font-normal"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className="grid size-9 shrink-0 place-items-center rounded-[var(--r)] border border-border [&>svg]:size-6"
                style={{ background: "var(--plate)", color: "var(--k, var(--fg))" }}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: chosenSvg ?? fallbackIcon }}
              />
              <span className="truncate text-sm font-medium">
                {value ? humanize(value) : "Aucune illustration"}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <ScopedPopoverContent container={rootRef.current}>
          {/* `Command` porte la recherche clavier de `cmdk`; `filter` remplace son score flou par
              exactement l'ancien contrat ("chaque mot tapé doit être présent"), voir `artFilter`. */}
          <Command filter={artFilter} style={toneStyle}>
            <CommandInput placeholder="Filtrer les dessins" />
            <CommandList className="max-h-[300px]">
              <CommandEmpty className="px-3 py-6 text-xs text-muted-foreground">
                Aucun dessin ne correspond. Les dessins sont nommés en anglais (« wine », « beer »,
                « tire »).
              </CommandEmpty>
              {/* ⚠⚠ `CommandPrimitive.Group` N'EST PAS DÉCORATIF ICI, MÊME SANS `heading`. Mesuré au
                  banc d'essai: sans lui, `cmdk` jette `TypeError: appendChild … not of type Node` à
                  CHAQUE frappe dans la recherche, et en silence côté React (l'erreur part d'un
                  gestionnaire d'évènement, elle ne casse pas la page) - le clavier tapait dans le
                  vide, aucun dessin ne se filtrait jamais. La cause: la fonction interne de `cmdk` qui
                  réordonne les résultats après une recherche cherche l'ancêtre marqué
                  `[cmdk-group-items]` de chaque `Item` pour savoir où le replacer; sans `Group`, cet
                  ancêtre n'existe nulle part et `appendChild(null)` explose, ce qui empêche aussi la
                  notification qui déclenche le nouveau rendu - donc le filtre RESTAIT invisible, pas
                  seulement le tri. Le `Group` n'a pas besoin de porter le style de la grille: sa seule
                  utilité est d'exister, la mise en page reste sur le `<div>` qu'il enveloppe. */}
              <CommandPrimitive.Group>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5 p-1.5">
                  {/* Toujours en tête ET toujours atteignable sous un filtre (voir `artFilter`):
                      retirer une illustration doit être aussi simple qu'en choisir une. */}
                  <CommandPrimitive.Item
                    value={NONE_VALUE}
                    keywords={["aucune", "aucun", "rien", "none"]}
                    data-picked={value === null}
                    aria-label="Aucune illustration, garder l'icône du rayon"
                    title="Aucune illustration, garder l'icône du rayon"
                    className={cell}
                    style={{ background: "var(--plate)", color: "var(--k, var(--fg))" }}
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="[&>svg]:size-6 [&>svg]:opacity-45"
                      dangerouslySetInnerHTML={{ __html: fallbackIcon }}
                    />
                  </CommandPrimitive.Item>

                  {entries.map((e) => (
                    <CommandPrimitive.Item
                      key={e.key}
                      value={e.key}
                      keywords={[e.human]}
                      data-picked={value === e.key}
                      aria-label={e.human}
                      title={e.human}
                      className={cell}
                      style={{ background: "var(--plate)", color: "var(--k, var(--fg))" }}
                      onSelect={() => {
                        onChange(e.key);
                        setOpen(false);
                      }}
                    >
                      {/* Même discipline que la vignette: la chaîne vient de la table figée du
                          code, la clé stockée ne sert qu'à l'y chercher. */}
                      <span
                        aria-hidden="true"
                        className="[&>svg]:size-9"
                        dangerouslySetInnerHTML={{ __html: PRODUCT_ART[e.key] ?? "" }}
                      />
                    </CommandPrimitive.Item>
                  ))}
                </div>
              </CommandPrimitive.Group>
            </CommandList>
          </Command>
        </ScopedPopoverContent>
      </Popover>

      <em className="block text-[10px] text-muted-foreground">
        {ART_KEYS.length} dessin{ART_KEYS.length > 1 ? "s" : ""} disponible
        {ART_KEYS.length > 1 ? "s" : ""}. Ils sont fournis avec le portail: rien à téléverser. Tapez
        le nom exact d&apos;un produit du jeu et le bon dessin se propose tout seul.
      </em>
    </div>
  );
}
