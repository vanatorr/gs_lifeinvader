"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceDot, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { money, toneVars } from "@/lib/business/theme";
import type { LineView, PeriodView, ProductView, RayonView, TicketView, Visual, WeekBar } from "./page";
import type { ClientRecordView } from "@/lib/business/clientRecord";
import s from "./ventes.module.css";

type PeriodId = "cur" | "prev";

const PERIODS: { id: PeriodId; label: string }[] = [
  { id: "cur", label: "Semaine en cours" },
  { id: "prev", label: "Semaine dernière" },
];

/** Une heure, en secondes. Sert au rythme horaire du bandeau: aucune date, donc aucun piège de fuseau. */
const SECONDS_PER_HOUR = 3600;

/** L'ordre dans lequel la légende du rythme doit se lire. Voir le `<ChartLegend>` pour le pourquoi. */
const LEGEND_ORDER = ["totalCents", "prevCents"];

function ticketWord(n: number): string {
  return `${n} ticket${n > 1 ? "s" : ""}`;
}

/** "7 h 45", "7 h", "0 h". Arithmétique pure: aucune date, donc aucun piège de fuseau ici. */
function hoursText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/**
 * Une part, en pourcent lisible.
 *
 * ⚠ `< 1 %` plutôt qu'un `0 %` arrondi: un rayon qui a vraiment vendu quelque chose ne doit pas
 * s'afficher comme s'il n'avait rien vendu, sinon la légende contredit la barre qu'elle légende.
 */
function pctText(share: number): string {
  const pct = Math.round(share * 100);
  if (pct === 0 && share > 0) return "< 1 %";
  return `${pct} %`;
}

/**
 * LE TON D'UN RAYON, EN JETON DE GRAPHIQUE.
 *
 * `--chart-1..4` sont les quatre tons de rayon de L'ENSEIGNE (pont shadcn de lib/business/theme.ts):
 * un graphique peint avec eux prend automatiquement les couleurs du commerce, sans jeu de couleurs
 * inventé par page et sans un seul hex écrit ici.
 *
 * ⚠ L'INDICE EST BORNÉ, comme dans `toneVars`, et pour la même raison: `tone` vient de la base
 * (Réglages), donc rien ne garantit qu'il vaille 1 à 4. Un `--chart-0` ou `--chart-9` n'existe pas,
 * la déclaration serait invalide, et Recharts dessinerait une forme sans remplissage - une part de
 * la barre simplement absente, ce qui se lit comme une donnée manquante et non comme une couleur
 * ratée.
 */
function chartTone(tone: number): string {
  const n = (((Math.trunc(tone) - 1) % 4) + 4) % 4 + 1;
  return `var(--chart-${n})`;
}

/**
 * L'écart avec la période précédente, ou rien.
 *
 * ⚠ RIEN, et pas "+100 %", quand la semaine précédente est à zéro: une recrue arrivée cette semaine
 * afficherait une progression inventée. Et rien non plus en regardant la semaine dernière, faute
 * d'antécédent dans ce que la page a chargé, comparer à la semaine SUIVANTE donnerait un non-sens.
 * Même règle que la maquette (`delta`, business-portal-demo.html).
 */
function deltaPct(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/**
 * COMPTE JUSQU'À `target`, PLUTÔT QUE DE L'AFFICHER D'UN COUP. Écrit à la main, aucune dépendance:
 * une seule boucle `requestAnimationFrame`, une courbe ease-out cubique, et rien d'autre. Anime au
 * premier montage (0 -> le chiffre du jour, comme une caisse enregistreuse qui compte) ET à chaque
 * bascule de période, depuis la VALEUR PRÉCÉDENTE, jamais depuis zéro sur un changement: repartir de
 * zéro à chaque bascule ferait clignoter la page plutôt que de montrer un écart.
 *
 * ⚠ RESPECTE `prefers-reduced-motion`: quelqu'un qui a demandé moins de mouvement au système
 * d'exploitation voit le chiffre final directement, sans la moindre boucle.
 */
function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(0);
  const prevTarget = useRef<number | null>(null);

  useEffect(() => {
    const from = prevTarget.current ?? 0;
    prevTarget.current = target;

    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from === target || reduceMotion) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}

/**
 * UN DESSIN, rendu depuis le carnet servi par la page.
 *
 * ⚠ `dangerouslySetInnerHTML` est acceptable ICI pour la même raison que sur la caisse, et pour
 * aucune autre: la chaîne ne vient PAS de la base, elle vient des tables figées de `lib/business/
 * art.ts`. La donnée stockée (`artKey`, l'icône du rayon) a servi d'INDEX côté serveur et n'a jamais
 * atteint le DOM. Un identifiant absent du carnet ne rend rien plutôt que d'inventer quoi que ce
 * soit: la page ne fabrique pas de contenu qu'elle n'a pas reçu.
 */
function Art({ id, visuals, cls }: { id: string; visuals: Record<string, Visual>; cls: string }) {
  const v = visuals[id];
  if (!v) return <span className={cls} aria-hidden="true" />;
  return (
    <span
      className={`${cls} ${v.kind === "icon" ? s.icon : ""}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: v.svg }}
    />
  );
}

/** Une ligne de ticket. Le prix de la ligne ne s'affiche pas: le montant qui compte est celui du
 *  ticket, en tête de ligne, et le répéter par article le noierait. */
function Line({ l, visuals }: { l: LineView; visuals: Record<string, Visual> }) {
  return (
    <span className={s.li} style={toneVars(l.tone) as React.CSSProperties}>
      <Art id={l.vis} visuals={visuals} cls={s.liv} />
      <span className={s.liq}>{l.qty}&times;</span>
      <span className={s.lin}>{l.label}</span>
    </span>
  );
}

/* ── Les deux graphiques ──────────────────────────────────────────────────────────────────────── */

/**
 * LE RYTHME DES SEPT JOURS, EN AIRE, AVEC LA SEMAINE PRÉCÉDENTE EN COMPARAISON.
 *
 * ⚠⚠ CE GRAPHE N'A PU DEVENIR CELUI-CI QU'APRÈS LA CORRECTION DES AGRÉGATS (voir l'entête de
 * page.tsx). Tant que la page additionnait `listSales`, une journée au-delà du plafond d'affichage
 * valait ZÉRO dans le graphe: la courbe montrait une semaine qui s'effondre le lundi alors que
 * c'était simplement le bout de la liste. Un graphe est plus dangereux qu'un tableau sur une donnée
 * tronquée, parce qu'une pente se lit sans être lue. Il fallait donc corriger la source AVANT de
 * dessiner mieux, pas l'inverse.
 *
 * DEUX SÉRIES SUPERPOSÉES, JAMAIS EMPILÉES (`stackId`), et c'est une différence de SENS avec la
 * maquette shadcn officielle dont ce composant reprend tout le reste: là-bas les deux séries
 * s'additionnent (deux catégories de visiteurs font un total de visiteurs). Ici la seconde série est
 * LA MÊME grandeur sur une AUTRE période: les empiler afficherait "cette semaine + la semaine
 * dernière", un nombre qui n'existe pas. Superposées, l'oeil lit l'écart, ce qui est la question.
 *
 * ⚠ ET SURTOUT PAS `totalCents` + `commissionCents` COMME DEUX SÉRIES EMPILÉES. La part employé
 * n'est pas une tranche du chiffre d'affaires: elle est versée par l'employeur EN PLUS, et ne sort
 * jamais de la facture du client. C'est l'inversion que le propriétaire a déjà fait corriger une
 * fois, et un graphe empilé la referait en plus grand. La part vit dans sa propre boîte, à côté.
 *
 * ⚠ `type="monotone"`, PAS `"natural"` comme la maquette officielle. Une spline "natural" dépasse
 * ses points de passage pour rester lisse: un jour à 0 $ coincé entre deux jours pleins creuse une
 * aire visible SOUS l'axe, comme si la personne avait perdu de l'argent ce jour-là. Repéré en direct
 * le 2026-08-09 sur le graphique voisin de la page Équipe (le propriétaire a vu le creux), et un
 * employé à un jour de repos au milieu de sa semaine est le cas NORMAL ici, pas un cas limite.
 *
 * ⚠ L'ABSCISSE EST `key` (`2026-08-03`), PAS `letter`. Les sept lettres françaises contiennent DEUX
 * "M" (mardi, mercredi): sur un axe de catégories, deux catégories homonymes ne sont plus
 * distinguables, ni pour le pointage de l'infobulle ni pour un `ReferenceDot` qui doit se poser sur
 * UN jour précis. La lettre reste ce qui est ÉCRIT sous l'axe, via un rendu de graduation qui la
 * retrouve par sa clé.
 */
function RythmeChart({ week, period }: { week: WeekBar[]; period: PeriodId }) {
  // Un identifiant de `useId` porte des caractères de ponctuation (deux-points, guillemets suivant
  // la version de React) qu'une référence `url(#...)` ne devrait pas avoir à transporter: on n'en
  // garde que l'alphanumérique, ce qui reste unique par instance du composant.
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hasPrev = week.some((w) => (w.prevCents ?? 0) > 0);
  const today = week.find((w) => w.today && w.totalCents > 0);

  const config = {
    totalCents: {
      label: period === "cur" ? "Cette semaine" : "Semaine dernière",
      color: "var(--chart-1)",
    },
    prevCents: { label: "Semaine précédente", color: "var(--chart-4)" },
  } satisfies ChartConfig;

  /**
   * La graduation d'un jour. Écrite à la main pour UNE raison: c'est le seul endroit qui peut encore
   * dire "aujourd'hui" sur l'axe. L'ancien graphe en barres marquait le jour courant en changeant la
   * teinte de SA barre; une aire est une forme continue et n'a pas de barre à teinter, donc le signal
   * se déplace sur la graduation et sur un point mis en avant (voir ReferenceDot plus bas).
   *
   * ⚠ `--brand-text` ICI, `--fg` SUR LE POINT, ET CE N'EST PAS UNE INCOHÉRENCE: les deux marqueurs
   * n'ont pas le même voisin à battre. La lettre doit se détacher des SIX AUTRES LETTRES, qui sont
   * grises (`--muted-foreground`), et `--brand-text` est précisément la teinte de marque calibrée
   * pour être lisible EN LETTRES sur le fond du portail (`--brand` brut y est presque illisible,
   * règle de business.css). Le point, lui, doit se détacher de L'AIRE, qui est déjà de la couleur de
   * marque: aucune variante de marque ne peut y arriver, donc c'est l'encre de la page.
   */
  const dayTick = (props: {
    x?: number | string;
    y?: number | string;
    payload?: { value?: string | number };
  }) => {
    const k = String(props.payload?.value ?? "");
    const day = week.find((w) => w.key === k);
    return (
      <text
        x={Number(props.x ?? 0)}
        y={Number(props.y ?? 0)}
        dy={11}
        textAnchor="middle"
        fontSize={9}
        fontWeight={700}
        fill={day?.today ? "var(--brand-text)" : "var(--muted-foreground)"}
      >
        {day?.letter ?? ""}
      </text>
    );
  };

  return (
    <ChartContainer config={config} className={s.chart}>
      <AreaChart data={week} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
        <defs>
          <linearGradient id={`cur${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-totalCents)" stopOpacity={0.72} />
            <stop offset="95%" stopColor="var(--color-totalCents)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        {/* Horizontales seules: les verticales d'une grille sur sept jours redoublent les graduations
            de l'axe sans rien ajouter, et hachurent une aire déjà remplie. */}
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="key" tickLine={false} axisLine={false} tickMargin={2} interval={0} tick={dayTick} />
        {/* Caché mais PRÉSENT: sans lui Recharts cale son échelle sur les deux séries de toute façon,
            et l'axe explicite documente que le plancher est zéro (une aire qui ne part pas de zéro
            exagère chaque écart). */}
        <YAxis type="number" domain={[0, "dataMax"]} hide />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
          content={
            <ChartTooltipContent
              indicator="dot"
              /* L'entête de l'infobulle porte le jour EN TOUTES LETTRES et son nombre de tickets. Le
                 libellé est déjà formaté côté serveur (voir FMT_DAY dans page.tsx): le reformater ici
                 le rendrait au fuseau du NAVIGATEUR, donc potentiellement à la veille. */
              labelFormatter={(_value, items) => {
                const day = items?.[0]?.payload as WeekBar | undefined;
                if (!day) return null;
                return (
                  <span className={s.tipHead}>
                    <b>{day.label}</b>
                    {day.ticketCount > 0 ? <em>{ticketWord(day.ticketCount)}</em> : null}
                  </span>
                );
              }}
              formatter={(value, name) => {
                const key = String(name) as keyof typeof config;
                return (
                  <span className={s.tipRow}>
                    <i style={{ background: config[key]?.color }} aria-hidden="true" />
                    <span className={s.tipName}>{config[key]?.label ?? name}</span>
                    <b>{money(Number(value))}</b>
                  </span>
                );
              }}
            />
          }
        />
        {/*
         * La légende EST l'entête du graphe: elle nomme les deux périodes, donc un titre au-dessus
         * ne dirait rien de plus dans un bandeau où chaque pixel de hauteur est compté.
         *
         * ⚠ SA CHARGE UTILE EST RETRIÉE AU PASSAGE, parce que celle que Recharts déduit tout seul
         * est arrivée DANS LE DÉSORDRE: relevé en navigateur, la légende affichait "Semaine
         * précédente" avant "Cette semaine" alors que les `<Area>` étaient déjà déclarées dans
         * l'autre sens. L'ordre d'enregistrement des séries chez Recharts n'est donc pas celui du
         * balisage, et la période qu'on REGARDE doit être nommée en premier. On ne peut pas non plus
         * passer un `payload` à `<Legend>` (Recharts 3 le retire de ses props publiques et le dérive
         * lui-même), donc le tri se fait dans la fonction de rendu, juste avant
         * `ChartLegendContent`. Il est conservé même après la réorganisation des deux `<Area>`
         * ci-dessous: cette réorganisation a d'autres raisons (voir son propre commentaire) et rien
         * ne garantit qu'elle suffise à elle seule à ordonner la légende.
         */}
        <ChartLegend
          verticalAlign="top"
          content={(props) => (
            <ChartLegendContent
              className={s.legend}
              verticalAlign="top"
              payload={[...(props.payload ?? [])].sort(
                (a, b) => LEGEND_ORDER.indexOf(String(a.dataKey)) - LEGEND_ORDER.indexOf(String(b.dataKey)),
              )}
            />
          )}
        />
        {/* ⚠ L'ORDRE DE CES DEUX SÉRIES EST DOUBLEMENT SIGNIFIANT. Recharts empile ses couches dans
            l'ordre du balisage ET construit sa légende dans le même ordre, donc déclarer la
            comparaison en premier la peindrait par-dessus la semaine qu'on regarde et la nommerait
            en tête de légende. La semaine en cours passe donc d'abord, remplie; la comparaison
            ensuite, en TRAIT SEUL. */}
        <Area
          dataKey="totalCents"
          type="monotone"
          stroke="var(--color-totalCents)"
          strokeWidth={2}
          fill={`url(#cur${gid})`}
          dot={{ r: 2, strokeWidth: 0, fill: "var(--color-totalCents)" }}
          activeDot={{ r: 4, strokeWidth: 0 }}
          isAnimationActive={false}
        />
        {/* ⚠ PAS DE REMPLISSAGE SUR LA COMPARAISON, et ce n'est pas une économie de style: deux aires
            remplies qui se croisent produisent une troisième forme, la zone d'intersection, qui n'est
            la valeur de personne et que l'oeil lit pourtant comme une donnée. Un trait pointillé
            posé sur l'aire dit "voilà où tu en étais" sans rien inventer. */}
        {hasPrev ? (
          <Area
            dataKey="prevCents"
            type="monotone"
            stroke="var(--color-prevCents)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            fill="none"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        ) : null}
        {/*
         * AUJOURD'HUI, deuxième signal, déclaré en dernier pour passer AU-DESSUS des deux aires.
         *
         * ⚠⚠ ENCRE DE LA PAGE (`--fg`), SURTOUT PAS `--primary`, ET C'EST UNE MESURE. Dans 3 des 4
         * palettes livrées (vigneron, bennys, strawberry) `--brand` ET `--k1` valent LE MÊME hex,
         * donc `--primary` et `--chart-1` sont la même couleur: un marqueur "aujourd'hui" en
         * `--primary` posé sur une série en `--chart-1` est litteralement invisible. L'ancien
         * graphique en barres portait exactement ce défaut (barre du jour en `--primary` parmi des
         * barres en `--chart-1`), donc son signal "aujourd'hui" ne fonctionnait que chez la
         * supérette. `--fg` contraste avec n'importe quelle teinte de marque, dans les deux thèmes,
         * et le contour `--card` détache le point de l'aire qu'il surmonte.
         */}
        {today ? (
          <ReferenceDot
            x={today.key}
            y={today.totalCents}
            r={4}
            fill="var(--fg)"
            stroke="var(--card)"
            strokeWidth={2}
          />
        ) : null}
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * DE QUOI EST FAIT LE CHIFFRE: une barre, un segment par rayon, aux couleurs DE L'ENSEIGNE.
 *
 * Ce n'est pas le classement d'articles en plus petit, c'est l'autre question. Le classement dit
 * QUEL article part le plus; celle-ci dit de QUOI vit la personne. Deux employés peuvent avoir le
 * même article en tête et vivre l'un de la cuisine, l'autre du vin.
 *
 * ⚠⚠ LES CLÉS DE SÉRIE SONT SYNTHÉTIQUES (`r1`, `r2`, …) ET C'EST UNE BARRIÈRE, PAS UN CONFORT.
 * `ChartStyle` (components/ui/chart.tsx) écrit chaque clé de `ChartConfig` DANS UN `<style
 * dangerouslySetInnerHTML>`, sous la forme `--color-<clé>: <couleur>;`. Or une clé de rayon est
 * écrite par le PATRON depuis les Réglages: une clé forgée refermerait la balise et exécuterait du
 * script sur l'origine de CITADEL, pour chaque employé qui ouvre la page. C'est exactement la faille
 * que lib/business/theme.ts documente sur la palette, sur un autre chemin. Un indice de position
 * n'est pas une donnée, donc il ne peut rien porter; le libellé du rayon, lui, ne traverse que du
 * texte React, qui est échappé.
 *
 * La couleur suit le même raisonnement: `chartTone` ne rend qu'un `var(--chart-N)` avec N borné à
 * 1..4, jamais une valeur venue de la base.
 */
function RayonMix({ rayons }: { rayons: RayonView[] }) {
  const series = rayons.map((r, i) => ({ ...r, id: `r${i + 1}`, color: chartTone(r.tone) }));

  const datum: Record<string, string | number> = { row: "rayons" };
  const config: ChartConfig = {};
  for (const x of series) {
    datum[x.id] = x.revenueCents;
    config[x.id] = { label: x.label, color: x.color };
  }
  const byId = new Map(series.map((x) => [x.id, x]));

  return (
    <>
      <ChartContainer config={config} className={s.mixBar}>
        <BarChart
          data={[datum]}
          layout="vertical"
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={0}
        >
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="row" hide />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name) => {
                  const r = byId.get(String(name));
                  return (
                    <span className={s.tipRow}>
                      <i style={{ background: r?.color }} aria-hidden="true" />
                      <span className={s.tipName}>{r?.label ?? name}</span>
                      <b>{money(Number(value))}</b>
                    </span>
                  );
                }}
              />
            }
          />
          {series.map((x, i) => (
            <Bar
              key={x.key}
              dataKey={x.id}
              stackId="rayons"
              fill={`var(--color-${x.id})`}
              isAnimationActive={false}
              /* Les extrémités seules sont arrondies: arrondir chaque segment ferait une chaîne de
                 gélules au lieu d'une barre unique, et une répartition doit se lire comme UN tout. */
              radius={[
                i === 0 ? 3 : 0,
                i === series.length - 1 ? 3 : 0,
                i === series.length - 1 ? 3 : 0,
                i === 0 ? 3 : 0,
              ]}
            />
          ))}
        </BarChart>
      </ChartContainer>

      {/* LA LÉGENDE EST ÉCRITE À LA MAIN ICI, et pas montée en `ChartLegendContent` comme celle du
          rythme juste au-dessus: celle-ci doit porter une VALEUR par entrée (la part en pourcent),
          ce que le composant shadcn ne sait pas faire (il ne rend qu'une pastille et un libellé), et
          elle doit pouvoir passer à la ligne, ce qu'une légende posée DANS le graphique ne peut pas
          sans se faire rogner par la hauteur que Recharts lui a réservée. */}
      <div className={s.mixKeys}>
        {series.map((x) => (
          <span key={x.key} className={s.mixKey} style={{ "--k": x.color } as React.CSSProperties}>
            <i aria-hidden="true" />
            <span className={s.mixNm}>{x.label}</span>
            <b>{pctText(x.share)}</b>
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * UNE LIGNE DU CLASSEMENT, EN `<Item>` (shadcn) DEPUIS LE 2026-08-09.
 *
 * ⚠ UNE LIGNE, PLUS UNE CARTE DANS UNE GRILLE. Une grille de cartes laisse des TROUS dès que le
 * nombre d'articles ne tombe pas juste sur le nombre de colonnes, et trois articles est le cas
 * courant ici. Une ligne ne peut pas faire de trou, et la barre de proportion y prend enfin la
 * largeur qu'il lui faut pour se lire comme un classement plutôt que comme un décor.
 *
 * `ItemMedia`/`ItemContent`/`ItemActions` reprennent exactement les trois emplacements qu'occupaient
 * `.rplate`/`.rmid`/`.rend`: le nom de classe de module de chacun reste posé dessus, donc la
 * géométrie mesurée (plaque 56px, barre de proportion, colonne de fin alignée à droite) ne bouge
 * pas d'un pixel, seul le vocabulaire du composant change.
 */
function RankRow({
  p,
  rank,
  visuals,
}: {
  p: ProductView;
  rank: number;
  visuals: Record<string, Visual>;
}) {
  return (
    <Item variant="outline" className={s.rrow} style={toneVars(p.tone) as React.CSSProperties}>
      <ItemMedia className={s.rplate}>
        <Art id={p.vis} visuals={visuals} cls={s.rfig} />
        <Badge className={s.rrank}>{rank}</Badge>
      </ItemMedia>
      <ItemContent className={s.rmid}>
        <span className={s.rcat}>{p.categoryLabel}</span>
        <ItemTitle className={s.rnm}>{p.label}</ItemTitle>
        <span className={s.rbar}>
          <i style={{ width: `${Math.round(p.share * 100)}%` }} />
        </span>
      </ItemContent>
      <ItemActions className={s.rend}>
        <span className={s.rqty}>
          <b>{p.qty}</b>
          <span>vendus</span>
        </span>
        <span className={s.rrev}>{money(p.revenueCents)}</span>
      </ItemActions>
    </Item>
  );
}

function TicketRow({
  t,
  visuals,
  showCommission,
  showMargin,
}: {
  t: TicketView;
  visuals: Record<string, Visual>;
  showCommission: boolean;
  /** Ce commerce connait-il son cout de revient. Voir `templateMeasuresCost`. */
  showMargin: boolean;
}) {
  return (
    <Item variant="outline" className={s.trow}>
      <span className={s.tamt}>{money(t.amountCents)}</span>
      <span className={s.tlines}>
        {t.lines.length === 0 ? (
          <span className={s.nolines}>Sans détail enregistré</span>
        ) : (
          t.lines.map((l) => <Line key={l.key} l={l} visuals={visuals} />)
        )}
        {t.hidden > 0 ? (
          <span className={s.more}>
            et {t.hidden} autre{t.hidden > 1 ? "s" : ""}
          </span>
        ) : null}
      </span>
      <span className={s.tmeta}>
        <span className={s.ttime}>{t.time}</span>
        <span className={`mono ${s.tref}`}>{t.publicRef}</span>
        {showMargin ? (
          <span className={s.tref}>bénéfice {money(t.marginCents)}</span>
        ) : null}
        {showCommission && t.commissionCents > 0 ? (
          <span className={s.tshare}>ta part +{money(t.commissionCents)}</span>
        ) : null}
      </span>
      {t.client ? <TicketFiche c={t.client} /> : null}
    </Item>
  );
}

/**
 * LA FICHE CLIENT SOUS LE TICKET: à qui, et sur quelle voiture.
 *
 * ⚠ SUR SA PROPRE LIGNE, EN TRAVERSANT LA GRILLE (`grid-column: 1 / -1`). `.trow` est une grille à
 * trois colonnes calibrées pour montant / détail / méta; y glisser un quatrième enfant écraserait
 * les trois plutôt que de s'ajouter dessous.
 *
 * ⚠ ET LE DÉFAUT DE LA VOITURE EST DIT, PAS OMIS. Une plaque introuvable et une voiture de série
 * s'affichent identiquement si l'on se contente de ne rien écrire quand il n'y a pas de
 * modifications: dans un cas la fiche désigne une voiture, dans l'autre elle ne désigne rien, et
 * c'est précisément ce que le patron a besoin de distinguer.
 */
function TicketFiche({ c }: { c: ClientRecordView }) {
  return (
    <span className={s.tfiche}>
      <span className={s.tfid}>
        <b>{c.name}</b>
        {c.dob ? <span>né(e) le {c.dob}</span> : null}
        {c.phone ? <span className="mono">{c.phone}</span> : null}
      </span>
      <span className={s.tfveh}>
        <b className="mono">{c.plate}</b>
        {c.vehicle ? <span>{c.vehicle}</span> : null}
        {c.fleetJob ? <span className={s.tffleet}>flotte {c.fleetJob}</span> : null}
        {c.vehicleNote ? (
          <span className={s.tfwarn}>{c.vehicleNote}</span>
        ) : c.modsTotal > 0 ? (
          <>
            {c.mods.map((m) => (
              <span key={m} className={s.tfmod}>
                {m}
              </span>
            ))}
            <span className={s.tfcount}>{c.modsTotal} mod.</span>
          </>
        ) : (
          <span className={s.tfstock}>d&apos;origine</span>
        )}
      </span>
    </span>
  );
}

/**
 * MES VENTES, côté navigateur.
 *
 * Les DEUX périodes arrivent déjà calculées depuis le serveur (voir page.tsx): basculer le sélecteur
 * ne relit rien, c'est un simple changement d'état local, comme le reste du portail n'a pas de
 * bouton "actualiser". Rien ici ne fait de requête ni ne recalcule un montant.
 *
 * ⚠ LE SÉLECTEUR DE PÉRIODE RESTE LE `.seg` DU PORTAIL, pas un `<Select>` shadcn comme la maquette
 * officielle du graphique en aires. Deux raisons, et aucune n'est la paresse: `.seg` est l'idiome
 * partagé de business.css, utilisé tel quel par les pages voisines (un menu déroulant ici ferait de
 * cette page la seule à commuter autrement), et un menu qui masque ses deux options derrière un clic
 * est un recul face à deux boutons qui montrent les deux et disent lequel est actif.
 *
 * LA COMPOSITION (verdict du propriétaire du 2026-08-09, *"i look at it i feel lost"*,
 * *"uneven higfhts"*, puis *"it must be profesionnal charting, graphing"*):
 *
 *     [ le chiffre | le rythme en aires | ta part / tes heures ]   <- un seul bandeau, toute la largeur
 *     [ le classement (+ répartition)   | le journal           ]
 *
 * ⚠⚠ LE BANDEAU TRAVERSE LES DEUX COLONNES DEPUIS LE 2026-08-09, ET C'EST CE QUI PAIE LE GRAPHE.
 * Avant, le graphique partageait la moitié gauche avec le chiffre et recevait `clamp(150px, 22vh,
 * 260px)` de large: sept barres y tenaient, une aire avec deux séries, une légende et un axe n'y
 * tiennent pas. En donnant la rangée entière au bandeau, la colonne du graphe passe d'environ 250px
 * à environ 660px sur un écran de 1440 sans qu'on ajoute une seule rangée à la page - donc sans
 * reprendre un pixel au classement ni au journal, qui gardent exactement la rangée du bas.
 *
 * Deux rangées, un ordre de lecture, et deux cellules d'une même rangée de grille ont la MÊME
 * hauteur par construction: l'alignement ne peut plus dériver quand une donnée change. Chaque moitié
 * qui n'a rien à montrer LAISSE SA PLACE à l'autre (`span2`) au lieu de rester là en boîte vide,
 * et le bandeau lui-même se recompose (`noChart`, `noAside`) quand un de ses trois blocs n'a pas
 * lieu d'être: c'est la règle qui fait tenir la page pour un employé à trois tickets, qui est le cas
 * le plus fréquent, pas le cas dégradé.
 */
export default function MesVentesView({
  employeeName,
  gradeName,
  canRead,
  showCommission,
  showMargin,
  showHours,
  periods,
  visuals,
}: {
  employeeName: string;
  gradeName: string;
  canRead: boolean;
  showCommission: boolean;
  /** Ce commerce connait-il son cout de revient. Voir `templateMeasuresCost`. */
  showMargin: boolean;
  showHours: boolean;
  periods: { cur: PeriodView; prev: PeriodView } | null;
  visuals: Record<string, Visual>;
}) {
  const [period, setPeriod] = useState<PeriodId>("cur");
  // Appelés AVANT le retour anticipé ci-dessous: les Rules of Hooks interdisent un hook conditionnel,
  // donc un repli à 0 ici plutôt que de sauter l'appel quand `periods` est encore nul.
  const heroCents = useCountUp(periods?.[period]?.totalCents ?? 0);
  const owedCents = useCountUp(periods?.[period]?.commissionCents ?? 0);

  if (!canRead || !periods) {
    return (
      <>
        <div className="head">
          <h1>Mes ventes</h1>
          <span className="sub">
            {employeeName}, {gradeName}
          </span>
        </div>
        {/* `sale.read.self` fait partie du repli jour-un: arriver ici veut dire que la direction
            l'a explicitement retirée à ce grade depuis les Réglages, pas un simple chargement. */}
        <div className="note">
          Vous n&apos;avez pas la permission de consulter vos ventes. Demandez à la direction de
          vous l&apos;accorder depuis les Réglages.
        </div>
      </>
    );
  }

  const d = periods[period];
  const isCur = period === "cur";
  const pct = isCur ? deltaPct(d.totalCents, periods.prev.totalCents) : null;
  const hasAside = showCommission || showHours;
  const hasSales = d.ticketCount > 0;
  const hasRank = d.products.length > 0;
  const hasMix = d.rayons.length > 1;
  const truncated = d.listedCount < d.ticketCount;

  /**
   * Le graphe n'a lieu d'être que s'il a quelque chose à tracer. Une aire strictement plate à zéro
   * n'est pas un graphique vide, c'est un graphique qui a l'air cassé: le bandeau rend alors sa
   * colonne au chiffre plutôt que d'exposer une courbe qui ne dit rien.
   */
  const hasRythme = d.week.some((w) => w.totalCents > 0 || (w.prevCents ?? 0) > 0);

  /** Le rythme horaire, seulement quand les deux grandeurs existent: diviser par zéro heure, ou
   *  annoncer 0 $ l'heure à quelqu'un qui n'a pas encore vendu, n'apprend rien à personne. */
  const perHour =
    showHours && d.hoursSeconds > 0 && d.totalCents > 0
      ? Math.round(d.totalCents / (d.hoursSeconds / SECONDS_PER_HOUR))
      : null;

  return (
    <>
      <div className="head">
        <h1>Mes ventes</h1>
        <span className="sub">
          {employeeName}, {gradeName}
        </span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Période">
          {PERIODS.map((p) => (
            <button key={p.id} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* `key={period}` force un vrai remontage React au lieu d'une simple mise à jour de props:
          c'est ce qui fait rejouer `.fadeIn` (une bascule sans ça n'est jamais un "mount", donc
          l'animation CSS ne se déclencherait qu'une fois, au premier chargement de la page). */}
      <div key={period} className={`${s.wrap} ${s.fadeIn}`}>
        {/* 1. COMBIEN J'AI FAIT, ET À QUEL RYTHME. Un seul chiffre domine, tout le reste l'annote. */}
        {/* `bg-transparent ring-0`: shadcn/Card empile son propre fond (`bg-card`) et son propre
            contour (`ring-1 ring-foreground/10`) via `cn()`, qui dédoublonne les classes Tailwind
            en conflit et laisse gagner celle passée en dernier - donc CES DEUX classes suffisent à
            retirer le coffrage sans toucher card.tsx. Le total est LA chose la plus forte de la
            page (voir le commentaire plus haut): un cadre autour de lui le range au même rang que
            les autres panneaux, alors qu'un chiffre qui flotte directement sur la page, sans
            bordure à traverser du regard, est ce qui le distingue vraiment. Les deux boîtes de
            synthèse, elles, gardent la leur: elles sont des annotations, pas le sujet. */}
        <Card
          className={`${s.hero} bg-transparent ring-0 ${hasRythme ? "" : s.noChart} ${hasAside ? "" : s.noAside}`}
        >
          <div className={s.heroMain}>
            <div>
              <div className={s.hk}>
                <span className="cap">Chiffre</span>
                <span className={s.hrange}>{d.rangeLabel}</span>
              </div>
              <div className={s.hbig}>{money(heroCents)}</div>
            </div>
            {/* ⚠ LE SÉPARATEUR VOYAGE AVEC LE FAIT QU'IL INTRODUIT (`.fact` porte son propre point),
                il n'est plus un frère de plus dans le flex. Sur une période chargée la ligne passe à
                deux rangées, et un point laissé seul en fin de première rangée se lit comme une
                phrase coupée. Mesuré à 1440: la ligne finissait par "aujourd'hui 6371 $ ·". */}
            <div className={s.hsub}>
              <span className={s.fact}>
                <b>{d.ticketCount}</b> ticket{d.ticketCount > 1 ? "s" : ""}
              </span>
              {d.ticketCount > 0 ? (
                <span className={s.fact}>
                  <i className={s.dot} />
                  panier moyen <b>{money(d.avgTicketCents)}</b>
                </span>
              ) : null}
              {/* "Aujourd'hui" n'a de sens que sur la semaine en cours. Sur la semaine dernière il
                  vaudrait honnêtement zéro, ce qui se lirait comme une mauvaise journée. */}
              {isCur ? (
                <span className={s.fact}>
                  <i className={s.dot} />
                  aujourd&apos;hui <b>{money(d.todaySumCents)}</b>
                </span>
              ) : null}
              {pct !== null ? (
                <span className={`delta ${pct > 0 ? "up" : pct < 0 ? "down" : "flat"}`}>
                  {pct > 0 ? "+" : ""}
                  {pct} % vs semaine dernière
                </span>
              ) : null}
              {/* Le pic est VISIBLE sur la courbe et son infobulle le nomme, mais seul un lecteur qui
                  survole le lit: la ligne de faits le dit à quelqu'un qui se contente de regarder.
                  `activeDays` et non `days.length`: le journal ne liste qu'une partie des journées
                  sur une période chargée, et "meilleur jour" n'a de sens qu'à partir de deux
                  journées travaillées, ce que seul l'agrégat sait. */}
              {d.bestDay && d.activeDays > 1 ? (
                <span className={s.fact}>
                  <i className={s.dot} />
                  meilleur jour <b>{d.bestDay.label.toLowerCase()}</b>, {money(d.bestDay.totalCents)}
                </span>
              ) : null}
            </div>
          </div>

          {/* Le rythme. Le graphe ne remplace aucune information: chaque journée est reprise en
              toutes lettres, avec son total, dans le journal. Rien n'existe ici seul. */}
          {hasRythme ? (
            <div className={s.heroChart}>
              <RythmeChart week={d.week} period={period} />
            </div>
          ) : null}

          {/* 2. COMBIEN ON ME DOIT. Les deux boîtes se partagent la hauteur du bandeau, donc leur
              bas tombe exactement sur celui du chiffre. */}
          {hasAside ? (
            <div className={s.aside}>
              {/* ⚠ Ce n'est PAS une remise et ça ne se soustrait de rien: le client paie le prix
                  affiché, l'employeur verse cette part en fin de semaine. La mêler au chiffre
                  d'affaires est l'inversion que le propriétaire a déjà corrigée une fois. */}
              {showCommission ? (
                <Card className={`${s.box} ${s.owed}`}>
                  <span className={`cap ${s.bk}`}>Ta part</span>
                  <span className={s.bv}>
                    {d.commissionCents > 0 ? `+${money(owedCents)}` : money(0)}
                  </span>
                  {/* ⚠ UNE PHRASE, PAS DEUX, et la coupe est mesurée: la boîte reçoit la moitié de
                      la hauteur du bandeau (~85px de contenu), et les deux phrases d'avant en
                      demandaient quatre lignes de plus que ça, donc l'explication se faisait
                      TRONQUER par le bas - une phrase coupée au milieu explique moins que rien. Les
                      deux faits qui comptent (c'est l'employeur qui verse, ce n'est pas pris au
                      client) tiennent en une phrase. */}
                  {/*
                    ⚠ LA PART SE LIT AVEC CE SUR QUOI ELLE PORTE. Un pourcentage du bénéfice affiché
                    sans le bénéfice à côté, c'est ce qui a laissé un stagiaire accumuler 20 900 $
                    sans que rien à l'écran ne dise d'où ça sortait (2026-08-27).
                  */}
                  <span className={s.bm}>
                    {showMargin && d.marginCents > 0
                      ? `${Math.round((d.commissionCents / d.marginCents) * 100)} % du bénéfice de l'entreprise, versée par l'employeur.`
                      : "Versée par l'employeur, jamais prise sur la facture du client."}
                  </span>
                </Card>
              ) : null}

              {/*
                ⚠ LE BÉNÉFICE DE L'ENTREPRISE, VU PAR LE VENDEUR. Ce n'est pas son argent et la
                légende le dit; c'est l'assiette de sa part, donc la seule chose qui rend son montant
                vérifiable de son côté.
                ⚠ `showMargin` est le MODÈLE du commerce, jamais `marginCents > 0`: chez une
                concession un zéro est une information (ce modèle-là ne rapporte rien), chez un bar
                la donnée n'existe pas du tout.
              */}
              {showMargin ? (
                <Card className={s.box}>
                  <span className={`cap ${s.bk}`}>Bénéfice déclaré</span>
                  <span className={s.bv}>{money(d.marginCents)}</span>
                  <span className={s.bm}>
                    Prix client moins prix concession, sur tes ventes. C&apos;est l&apos;assiette de
                    ta part, pas ton argent.
                  </span>
                </Card>
              ) : null}

              {showHours ? (
                <Card className={s.box}>
                  <span className={`cap ${s.bk}`}>Heures</span>
                  <span className={s.bv}>{hoursText(d.hoursSeconds)}</span>
                  {/* ⚠ LE RYTHME HORAIRE VIT ICI, PAS DANS LA LIGNE DE FAITS, et pour deux raisons.
                      La place: mesuré à 1180px, un sixième fait faisait passer la ligne à quatre
                      rangées, qui débordaient du bandeau (hauteur fixe) et venaient se poser SUR le
                      panneau du dessous. Et le sens: un montant à l'heure ne veut rien dire sans le
                      pointage dont il est tiré, or c'est exactement ce que cette boîte annonce et
                      met en garde. Replié dans la phrase, il ne coûte pas une ligne de plus. */}
                  {/* ⚠ DEUX LIGNES MAXIMUM, ET C'EST MESURE, PAS UNE PREFERENCE. La boîte reçoit la
                      moitié de la hauteur intérieure du bandeau, soit ~80px à 1180px de fenêtre, dont
                      ~28 restent pour cette phrase une fois l'intitulé et le chiffre posés: à ~34
                      signes par ligne sur une colonne de 182px, ça fait 65 signes. Une phrase plus
                      longue ne défile pas et ne rétrécit pas, elle se fait couper AUX DEUX BOUTS
                      (`align-content: center`), donc on perd aussi le haut de l'intitulé. La période
                      n'est pas répétée ici pour cette raison: le bandeau la donne déjà en toutes
                      lettres à côté du chiffre. */}
                  <span className={s.bm}>
                    {perHour !== null ? (
                      <>
                        Environ <b>{money(perHour)}</b> l&apos;heure, d&apos;après le pointage en jeu.
                      </>
                    ) : (
                      <>De service, d&apos;après le pointage enregistré en jeu.</>
                    )}
                  </span>
                </Card>
              ) : null}
            </div>
          ) : null}
        </Card>

        {/* 3. QU'EST-CE QUE JE VENDS, de haut en bas: la répartition par rayon puis les articles,
            avec les vrais dessins produits. Le panneau n'existe que s'il a quelque chose à montrer;
            sinon le journal prend les deux colonnes. */}
        {hasSales && hasRank ? (
          <Card className={`${s.pane} ${hasMix ? s.paneMix : ""}`}>
            <div className={s.phead}>
              <span className="cap">Mes meilleures ventes</span>
              <span className="dim">{d.itemsSold} articles vendus</span>
            </div>

            {/* La répartition n'a de sens qu'à partir de deux rayons: un seul segment pleine largeur
                dit "100 % de ce que je vends vient du seul rayon où je vends", ce que le classement
                juste en dessous dit déjà mieux. */}
            {hasMix ? (
              <div className={s.mix}>
                <RayonMix rayons={d.rayons} />
              </div>
            ) : null}

            <div className={`${s.pbody} ${s.one}`}>
              {/* `--n` plafonne l'étirement des lignes: voir le commentaire de `.rlist`. Le nombre
                  de lignes est connu ici et nulle part ailleurs. */}
              <ItemGroup className={s.rlist} style={{ "--n": d.products.length } as React.CSSProperties}>
                {d.products.map((p, i) => (
                  <RankRow key={p.key} p={p} rank={i + 1} visuals={visuals} />
                ))}
              </ItemGroup>
            </div>
            <div className={s.pfoot}>
              <span>
                {d.productCount} article{d.productCount > 1 ? "s" : ""} différent
                {d.productCount > 1 ? "s" : ""}
              </span>
              {d.productCount > d.products.length ? (
                <span className="dim">les {d.products.length} premiers</span>
              ) : null}
            </div>
          </Card>
        ) : null}

        {/* 4. LE JOURNAL. Groupé par journée, une ligne par ticket, montant en tête. */}
        <Card className={`${s.pane} ${hasSales && hasRank ? "" : s.span2}`}>
          <div className={s.phead}>
            <span className="cap">Mes tickets</span>
            {/* ⚠ LE JOURNAL DIT CE QU'IL MONTRE. `ticketCount` est le vrai compte de la période
                (agrégat SQL), `listedCount` ce que la lecture d'affichage a ramené: sur une semaine
                chargée les deux diffèrent, et écrire le vrai compte au-dessus d'une liste plus
                courte, sans le dire, ferait croire à des tickets disparus. Voir l'entête de
                page.tsx pour pourquoi les deux nombres existent séparément. */}
            <span className="dim">
              {truncated ? `${d.listedCount} affichés sur ${d.ticketCount}` : d.ticketCount}
            </span>
          </div>

          {hasSales ? (
            <div className={`${s.pbody} ${d.days.length === 1 ? s.one : ""}`}>
              {d.days.map((day) => (
                <div key={day.key} className={s.jday}>
                  <div className={s.dhead}>
                    <span className={s.dnm}>{day.label}</span>
                    <span className={s.dfil} />
                    <span className={s.dct}>
                      {ticketWord(day.ticketCount)}
                      {day.tickets.length < day.ticketCount ? `, ${day.tickets.length} affichés` : ""}
                    </span>
                    <span className={s.dtot}>{money(day.totalCents)}</span>
                  </div>
                  <ItemGroup className={s.jlist} style={{ "--n": day.tickets.length } as React.CSSProperties}>
                    {day.tickets.map((t) => (
                      <TicketRow
                        key={t.publicRef}
                        t={t}
                        visuals={visuals}
                        showCommission={showCommission}
                        showMargin={showMargin}
                      />
                    ))}
                  </ItemGroup>
                </div>
              ))}
            </div>
          ) : (
            <Empty className={s.hollow}>
              <EmptyHeader>
                <EmptyTitle className="cap">Aucune vente sur la période</EmptyTitle>
                <EmptyDescription className={s.hollowP}>
                  {isCur
                    ? "Vos tickets apparaîtront ici dès la première vente déclarée à la caisse."
                    : "Rien n'a été déclaré sur cette semaine."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className={s.pfoot}>
            <span>Total de la période</span>
            <b>{money(d.totalCents)}</b>
          </div>
        </Card>
      </div>
    </>
  );
}
