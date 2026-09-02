import Link from "next/link";
import { Clock, PackageSearch, Receipt } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { visualFor } from "@/lib/business/art";
import { initials, money, toneVars } from "@/lib/business/theme";
import type { ClientRecordView } from "@/lib/business/clientRecord";
import {
  HoursBarChart,
  MAX_SERIES,
  MixChart,
  PeriodSelect,
  RhythmAreaChart,
  type DayRow,
  type HourPoint,
  type MixPoint,
  type Series,
} from "../SalesChart";
// `Period` vient de `../periods`, pas de `../SalesChart`: voir l'en-tête de periods.ts (un module
// "use client" ne peut pas servir de point de passage pour ce que le serveur lit aussi).
import { type Period } from "../periods";
import s from "../equipe.module.css";

export type { Period };

/**
 * Un jour de la période: ce qu'IL a déclaré, et ce que le commerce entier a déclaré.
 *
 * Les deux voyagent ensemble parce que le graphique de tête les empile: "reste de l'équipe" est
 * `team - mine`, une soustraction qui n'a de sens que si les deux nombres viennent du MÊME agrégat
 * (`dailyTotals(bySeller)`). Les calculer séparément laisserait un jour où le reste serait négatif.
 */
export type DayCell = {
  key: string;
  label: string;
  full: string;
  today: boolean;
  mine: number;
  team: number;
};

/** Un article, agrégé en SQL sur toutes SES ventes de la période. */
export type TopProduct = {
  /** `itemId` quand l'article existe encore au catalogue, sinon rayon plus libellé de la ligne. */
  key: string;
  label: string;
  categoryLabel: string;
  /** L'entrée de palette du rayon (1 à 4). Posée par `toneVars`, jamais une couleur écrite ici. */
  tone: number;
  /** Clé de dessin, VENUE DE LA BASE: elle sert d'INDEX dans la table figée de art.ts, jamais de contenu. */
  artKey: string | null;
  /** L'icône déclarée par le rayon, repli quand l'article n'a pas de dessin. Même nature de clé. */
  categoryIcon: string | null;
  qty: number;
  revenueCents: number;
};

export type TicketView = {
  id: number;
  publicRef: string;
  when: string;
  detail: string;
  note: string | null;
  totalCents: number;
  commissionCents: number;
  /** Le benefice mesurable du ticket. Voir `margin_cents` dans le schema: 0 = non mesure. */
  marginCents: number;
  backdated: boolean;
  /** La fiche client du ticket, ou null. Mise en forme par `clientRecordView`, comme mes-ventes. */
  client: ClientRecordView | null;
};

export type ShiftView = {
  id: number;
  day: string;
  range: string;
  seconds: number;
  why: string;
  open: boolean;
};

const SECONDS_PER_HOUR = 3600;

/** "18,5 h" depuis des secondes. Même règle que la page Équipe: virgule française, une décimale. */
function hoursLabel(seconds: number): string {
  const hours = seconds / SECONDS_PER_HOUR;
  return `${hours.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** Un pourcentage entier, borné à [0, 100]. */
function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * LE DESSIN D'UN ARTICLE, sur la même plaque claire que la vignette de la Caisse.
 *
 * ⚠ `dangerouslySetInnerHTML` est acceptable ICI pour exactement la même raison qu'en Caisse, et
 * pour aucune autre: la chaîne rendue ne vient PAS de la base, elle vient d'une table figée du code.
 * La donnée stockée (`artKey`, `icon`) sert seulement de CLÉ DE RECHERCHE, et une clé inconnue
 * retombe sur le repli. C'est la distinction index / contenu, celle qui manquait à la palette avant
 * le 2026-08-08.
 */
function ProductVisual({ artKey, icon }: { artKey: string | null; icon: string | null }) {
  const v = visualFor(artKey, icon);
  return <div className={`tvis ${v.kind}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: v.svg }} />;
}

/**
 * FICHE EMPLOYÉ, côté navigateur.
 *
 * Composant serveur, comme EquipeView: le seul état est la période, elle vit dans l'URL et le
 * sélecteur (`PeriodSelect`) ne fait que pousser une nouvelle adresse.
 *
 * ⚠⚠ C'EST ICI QUE VIT L'ANALYSE PAR PERSONNE, DEPUIS QUE LE RELEVÉ D'ÉQUIPE EST UNE LISTE. Demande
 * du propriétaire, verbatim: "gestion/equipe employee page needs way better graphs ... this should
 * just be a list that opens team page". Les grandes cartes portraits ont disparu de la page Équipe;
 * ce qu'elles montraient (le rythme de la personne) et ce qu'elles ne montraient pas (contre quoi
 * le comparer) sont devenus TROIS graphiques ici, choisis pour répondre à trois questions
 * différentes qu'un gérant se pose vraiment:
 *
 *   1. "Comment tourne-t-il, et quelle part du commerce est-ce ?" -> l'aire EMPILÉE de tête. Ses
 *      ventes et le reste de l'équipe, jour par jour. Une aire seule aurait montré sa forme sans
 *      jamais dire si c'est beaucoup; empilée contre le reste, la même surface répond aux deux.
 *   2. "Vend-il toujours la même chose ?" -> le radar par rayon, cette période contre la
 *      précédente. Un vendeur qui a glissé du vin vers la cuisine a le même chiffre et une forme
 *      différente: aucun total ne le dit, aucune barre ne le dit d'un coup d'oeil.
 *   3. "Ce chiffre, en combien de temps ?" -> les heures par jour, avec le rendement dans la bulle.
 *
 * ⚠ AUCUN GRAPHIQUE NE REDIT UN CHIFFRE DÉJÀ ÉCRIT EN HAUT. La bande de figures porte les
 * constantes de la période; les graphiques portent ce qui CHANGE à l'intérieur (jour par jour,
 * rayon par rayon, contre la période d'avant). Un camembert de la répartition du chiffre entre deux
 * personnes aurait été un quatrième graphique disant "62 pour cent", nombre déjà écrit en figure.
 *
 * ⚠ AUCUNE COMMANDE DE PAIEMENT. "Part à percevoir" est un CONSTAT; il n'existe ici ni bouton
 * verser, ni case "réglé", ni compteur de solde à zéro. Règle du propriétaire: le portail ne paie
 * personne, l'employeur verse en jeu.
 */
export default function EmployeView({
  slug,
  identifier,
  name,
  gradeLabel,
  former,
  period,
  canRead,
  deniedReason,
  showHours,
  showCommission,
  showMargin,
  onDutySeconds,
  totalCents,
  commissionCents,
  marginCents,
  prevTotalCents,
  salesCount,
  teamTotalCents,
  teamHeadcount,
  workedSeconds,
  itemsSold,
  distinctProducts,
  products,
  mix,
  mixPrevTotalCents,
  tickets,
  ticketsTotal,
  shifts,
  hours,
  days,
  shiftsTruncated,
}: {
  slug: string;
  identifier: string;
  name: string | null;
  gradeLabel: string | null;
  /**
   * La personne ne tient plus ce metier dans le jeu. Sa fiche reste consultable et ses chiffres
   * restent exacts: ils decrivent une periode pendant laquelle elle y travaillait.
   */
  former: boolean;
  period: Period;
  canRead: boolean;
  deniedReason: string | null;
  showHours: boolean;
  showCommission: boolean;
  /** Ce commerce connait-il son cout de revient. Voir `templateMeasuresCost`. */
  showMargin: boolean;
  onDutySeconds: number | null;
  totalCents: number;
  commissionCents: number;
  marginCents: number;
  prevTotalCents: number;
  /** Le nombre de tickets de la PÉRIODE, agrégé en SQL. `tickets.length` n'en est que l'extrait affiché. */
  salesCount: number;
  teamTotalCents: number;
  teamHeadcount: number;
  workedSeconds: number;
  itemsSold: number;
  /** Le nombre TOTAL de références distinctes, `products` n'en portant que les mieux classées. */
  distinctProducts: number;
  products: TopProduct[];
  mix: MixPoint[];
  /** Son chiffre par rayon sur la période précédente, cumulé: sert à savoir s'il y a un profil à
   *  comparer. Zéro veut dire "rien à superposer", pas "profil plat". */
  mixPrevTotalCents: number;
  tickets: TicketView[];
  ticketsTotal: number;
  shifts: ShiftView[];
  hours: HourPoint[];
  days: DayCell[];
  shiftsTruncated: boolean;
}) {
  const equipeBase = `/business/${slug}/gestion/equipe`;
  const base = `${equipeBase}/${encodeURIComponent(identifier)}`;
  const keep = period === "cur" ? "" : `?p=${period}`;

  // Même règle que le relevé d'équipe: sans chiffre précédent il n'y a pas de variation à calculer,
  // seulement un fait à écrire. Voir `trendOf` dans EquipeView pour le raisonnement complet.
  const delta =
    prevTotalCents > 0 ? Math.round(((totalCents - prevTotalCents) / prevTotalCents) * 100) : null;
  const deltaTone = delta === null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const shareOfTeam = pct(totalCents, teamTotalCents);

  /**
   * LES DEUX SÉRIES DE LA COURBE DE TÊTE.
   *
   * "Reste de l'équipe" n'apparaît que s'il y a un reste. Sur un commerce à un seul vendeur, une
   * seconde aire plate à zéro ajouterait une légende, une couleur et une ligne de bulle pour
   * affirmer qu'il ne s'est rien passé ailleurs: du bruit, pas de l'information.
   */
  const restTotal = days.reduce((acc, d) => acc + Math.max(0, d.team - d.mine), 0);
  const series: Series[] = [{ key: "s0", label: name ?? "Cet employé", tone: 1 }];
  // Lui au FOND de la pile (il est le sujet, sa surface part de l'axe et se lit directement), le
  // reste de l'équipe posé dessus en teinte neutre et sans remplissage appuyé: c'est un repère
  // d'échelle, pas une seconde histoire à raconter.
  if (restTotal > 0) {
    series.push({ key: "s1", label: "Reste de l'équipe", tone: MAX_SERIES, muted: true });
  }
  const chartRows: DayRow[] = days.map((d) => {
    const values: Record<string, number> = { s0: d.mine };
    if (restTotal > 0) values.s1 = Math.max(0, d.team - d.mine);
    return { key: d.key, label: d.label, full: d.full, today: d.today, values };
  });

  const first = days[0];
  const last = days[days.length - 1];
  const rangeLabel =
    first && last ? `Du ${first.full.toLowerCase()} au ${last.full.toLowerCase()}` : "";

  const mixHasData = mix.some((m) => m.cur > 0 || m.prev > 0);
  const mixCurTotalCents = mix.reduce((acc, m) => acc + m.cur, 0);
  // Le rayon qui pèse le plus SUR CETTE PÉRIODE. `null` quand il n'a rien vendu: on ne désigne pas
  // un dominant parmi des zéros, ce serait nommer un vainqueur dans une course sans partants.
  const leader = mixCurTotalCents > 0 ? mix.reduce((a, m) => (m.cur > a.cur ? m : a)) : null;
  const hoursHasData = hours.some((h) => h.seconds > 0);

  return (
    <>
      <div className="head">
        <Link href={`${equipeBase}${keep}`} className="chip">
          Retour à l&apos;équipe
        </Link>
        <Avatar size="lg">
          <AvatarFallback>{initials(name ?? "?")}</AvatarFallback>
        </Avatar>
        <h1>{name ?? "Employé"}</h1>
        {/* ⚠ Plus de repli "Grade inconnu" écrit à la place d'un grade: l'annuaire du jeu donne le
            grade courant de tout employé en poste, donc l'absence de libellé ne peut plus signifier
            que « cette personne ne tient plus ce métier », ce que l'étiquette voisine dit déjà en
            clair. Afficher les deux reviendrait à annoncer une panne à côté d'une explication. */}
        {gradeLabel !== null ? <Badge variant="secondary">{gradeLabel}</Badge> : null}
        {former ? (
          /* Une mention calme, jamais un avertissement: quitter un métier est un fait de calendrier.
             `tag q` est le jeton neutre du portail (`--muted-text` sur `--line`), pas `warn`. */
          <span className={`tag q ${s.formerTag}`} title="Ne tient plus ce métier dans le jeu">
            Ancien employé
          </span>
        ) : null}
        {onDutySeconds !== null ? (
          <span className="tag on" title={`En service depuis ${hoursLabel(onDutySeconds)}`}>
            <i />
            En service
          </span>
        ) : null}
        <span className="sub mono">{identifier}</span>
        <div className="spacer" />
        <PeriodSelect base={base} period={period} />
      </div>

      {!canRead ? (
        <div className="panel">
          <p className="pick">{deniedReason}</p>
        </div>
      ) : (
        <>
          {/* Au moins TROIS figures en toutes circonstances, quels que soient les modules actifs:
              une bande pleine largeur qui ne porte qu'un chiffre est un panneau presque vide. */}
          <div className="figs">
            <div className="fig">
              <div className="k">Chiffre déclaré</div>
              <div className="v lead">{money(totalCents)}</div>
              <div className="m">
                {delta === null ? (
                  "aucune vente la période précédente"
                ) : (
                  <>
                    <span className={`delta ${deltaTone}`}>
                      {delta > 0 ? "+" : ""}
                      {delta} %
                    </span>{" "}
                    vs {money(prevTotalCents)} la période précédente
                  </>
                )}
              </div>
            </div>
            <div className="fig">
              <div className="k">Part de l&apos;équipe</div>
              <div className="v num">{shareOfTeam} %</div>
              <div className="m">
                {teamHeadcount > 1
                  ? `sur ${teamHeadcount} vendeurs, ${money(teamTotalCents)} au total`
                  : "seul vendeur de la période"}
              </div>
            </div>
            <div className="fig">
              <div className="k">Panier moyen</div>
              <div className="v">
                {salesCount > 0 ? money(Math.round(totalCents / salesCount)) : "0 $"}
              </div>
              <div className="m">
                sur {salesCount} ticket{salesCount > 1 ? "s" : ""}
              </div>
            </div>
            <div className="fig">
              <div className="k">Articles vendus</div>
              <div className="v num">{itemsSold}</div>
              <div className="m">
                {distinctProducts} référence{distinctProducts > 1 ? "s" : ""} différente
                {distinctProducts > 1 ? "s" : ""}
              </div>
            </div>
            {showHours ? (
              <div className="fig">
                <div className="k">Heures</div>
                <div className="v">{hoursLabel(workedSeconds)}</div>
                <div className="m">
                  {workedSeconds > 0 && totalCents > 0
                    ? `${money(Math.round(totalCents / (workedSeconds / SECONDS_PER_HOUR)))} par heure`
                    : `${shifts.length} service${shifts.length > 1 ? "s" : ""}`}
                </div>
              </div>
            ) : null}
            {/*
              ⚠ LE BÉNÉFICE SE LIT À CÔTÉ DU CHIFFRE, ET AVANT LA PART. C'est l'ordre dans lequel la
              question se pose: ce que le client a payé, ce que l'entreprise a gagné dessus, ce
              qu'elle en reverse. Une part affichée sans le bénéfice à côté est exactement ce qui a
              laissé 20 900 $ s'accumuler sans que rien à l'écran ne dise sur quoi.
              ⚠ LE DRAPEAU EST LE MODÈLE DU COMMERCE, JAMAIS `marginCents > 0`: un bénéfice
              réellement nul sur la période DOIT s'afficher 0 chez une concession (c'est
              l'information), alors qu'un bar ne doit pas voir la figure du tout (il n'a aucun coût
              de revient enregistré, voir `templateMeasuresCost`).
            */}
            {/*
              ⚠ "DÉCLARÉ", ET LE MOT EST OBLIGATOIRE ICI ALORS QUE LA PAGE ÉQUIPE DIT "RÉEL". Le vrai
              résultat vient du grand livre du jeu, et il ne se répartit PAS par personne: mesuré le
              2026-08-27, les 409 mouvements `billing_payout` des trois commerces ont tous un
              `actor_identifier` vide, donc le jeu n'enregistre nulle part qui a émis une facture.
              Répartir au prorata de quelque chose fabriquerait le chiffre sur lequel une paie est
              versée. Cette figure porte donc ce que la personne a déclaré, et le dit.
            */}
            {showMargin ? (
              <div className="fig">
                <div className="k">Bénéfice déclaré</div>
                <div className="v">{money(marginCents)}</div>
                <div className="m">
                  {totalCents > 0
                    ? `${Math.round((marginCents / totalCents) * 100)} % de ses ventes déclarées`
                    : "sur ses ventes déclarées"}
                </div>
              </div>
            ) : null}
            {showCommission ? (
              <div className="fig">
                <div className="k">Part à percevoir</div>
                <div className="v">{money(commissionCents)}</div>
                {/* Jamais un bouton: le portail constate ce qui est dû, l'employeur le verse en jeu. */}
                <div className="m">
                  {showMargin && marginCents > 0
                    ? `versée par l'employeur, ${Math.round((commissionCents / marginCents) * 100)} % du bénéfice`
                    : "versée par l'employeur"}
                </div>
              </div>
            ) : null}
          </div>

          <div className={s.work}>
            <div className={s.wmain}>
              {/* LE GRAPHIQUE DE TÊTE, et l'absorbeur de la colonne. */}
              <Card
                className={`${s.chartCard} ${s.chartLead} rounded-[var(--r)] border border-border ring-0`}
              >
                {/* `grid-cols-1` explicite: voir le commentaire au meme endroit dans EquipeView. */}
                <CardHeader className="grid-cols-1">
                  <CardTitle>Son rythme</CardTitle>
                  <CardDescription>
                    {rangeLabel}
                    {restTotal > 0 ? ", empilé sur le reste de l'équipe" : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className={s.chartBody}>
                  {days.length === 0 ? (
                    <p className="pick">Aucun jour à afficher sur cette période.</p>
                  ) : (
                    /* ⚠ `empty`: sans lui, une période où NI cette personne NI le commerce n'ont rien
                       vendu rend une toile parfaitement vide (Recharts ne trace alors ni aire, ni
                       courbe, ni graduation d'ordonnée, mesuré le 2026-08-10), ce qui ne se distingue
                       pas d'une panne. Voir l'en-tête de `RhythmAreaChart`. */
                    <RhythmAreaChart
                      data={chartRows}
                      series={series}
                      className={`${s.chartFill} aspect-auto h-full w-full`}
                      empty={<p className="pick">Aucune vente sur cette période, ni pour lui ni pour le commerce.</p>}
                    />
                  )}
                </CardContent>
              </Card>

              {/* CE QU'IL VEND. L'information la plus utile d'une fiche employé, et celle qui
                  manquait entièrement à l'origine: la page listait des références de tickets sans
                  jamais dire ce qu'il y avait dedans. Le dessin vient de la même bibliothèque que
                  la Caisse, donc un article se reconnaît à l'identique d'un écran à l'autre. */}
              <div className={`panel ${s.absorb}`}>
                <div className="ph">
                  <span className="cap">Ce qu&apos;il vend le plus</span>
                  {/* Le classement est plafonné: on dit sur quoi il porte plutôt que de laisser
                      croire que ce sont toutes ses références. */}
                  <span className="dim">
                    {distinctProducts === 0
                      ? "aucun article"
                      : distinctProducts > products.length
                        ? `${products.length} sur ${distinctProducts}`
                        : `${products.length} référence${products.length > 1 ? "s" : ""}`}
                  </span>
                </div>
                {products.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PackageSearch strokeWidth={1.75} aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>Aucun article vendu</EmptyTitle>
                      <EmptyDescription>Rien n&apos;a été déclaré sur cette période.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className={s.scroll}>
                    <div className={s.prods}>
                      {products.map((p) => (
                        <Card
                          key={p.key}
                          size="sm"
                          className={`${s.prodCard} gap-0 py-0`}
                          style={toneVars(p.tone) as React.CSSProperties}
                        >
                          <ProductVisual artKey={p.artKey} icon={p.categoryIcon} />
                          <CardContent className={s.pbody}>
                            <div className={s.pcat}>{p.categoryLabel}</div>
                            <div className={s.pnm}>{p.label}</div>
                            <div className={s.pqty}>
                              {p.qty}
                              <em>vendu{p.qty > 1 ? "s" : ""}</em>
                            </div>
                            <div className={s.pval}>{money(p.revenueCents)}</div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className={`panel ${s.absorb}`}>
                <div className="ph">
                  <span className="cap">Ses tickets</span>
                  {/* ⚠ Un extrait se DIT, et il se dit AVEC son dénominateur. Le fil montre les plus
                      récents; les chiffres du haut, eux, portent sur la période entière (agrégats
                      SQL). Écrire les deux nombres est ce qui empêche de lire ce panneau comme un
                      total. */}
                  <span className="dim">
                    {ticketsTotal > tickets.length
                      ? `${tickets.length} plus récents sur ${ticketsTotal}`
                      : `${tickets.length} ticket${tickets.length > 1 ? "s" : ""}`}
                  </span>
                </div>
                {tickets.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Receipt strokeWidth={1.75} aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>Aucune vente déclarée</EmptyTitle>
                      <EmptyDescription>Rien n&apos;a été enregistré sur cette période.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className={s.scroll}>
                    <div className={s.tickets}>
                      {tickets.map((t) => (
                        <Card key={t.id} size="sm" className={s.tkCard}>
                          <CardContent className={s.tkBody}>
                            <div className={s.tkh}>
                              <span className={s.tkref}>{t.publicRef}</span>
                              <span className={s.tkwhen}>{t.when}</span>
                            </div>
                            <div className={s.tkamt}>{money(t.totalCents)}</div>
                            <div className={s.tkdet}>{t.detail}</div>
                            {t.note ? <div className={s.tkdet}>Note : {t.note}</div> : null}
                            {showMargin ? (
                              <div className={s.tkdet}>Bénéfice {money(t.marginCents)}</div>
                            ) : null}
                            {showCommission && t.commissionCents > 0 ? (
                              <div className={s.tkshare}>Part {money(t.commissionCents)}</div>
                            ) : null}
                            {t.backdated ? <div className={s.tkflag}>Antidatée</div> : null}
                            {/* ⚠ LA FICHE EST DANS LA CARTE DU TICKET, pas dans une colonne à part.
                                C'est la réponse à "qu'est-ce qui a été fait sur cette voiture, et
                                par qui": séparer les deux obligerait à recroiser deux listes à
                                l'oeil pour reconstituer un seul fait. */}
                            {t.client ? (
                              <div className={s.tkfiche}>
                                <div className={s.tkfrow}>
                                  <b>{t.client.name}</b>
                                  {t.client.dob ? <span>né(e) le {t.client.dob}</span> : null}
                                  {t.client.phone ? (
                                    <span className="mono">{t.client.phone}</span>
                                  ) : null}
                                </div>
                                <div className={s.tkfrow}>
                                  <b className="mono">{t.client.plate}</b>
                                  {t.client.vehicle ? <span>{t.client.vehicle}</span> : null}
                                  {t.client.fleetJob ? (
                                    <span className={s.tkffleet}>flotte {t.client.fleetJob}</span>
                                  ) : null}
                                </div>
                                {/* Une plaque introuvable et une voiture de série ne doivent JAMAIS
                                    se ressembler ici: dans un cas la fiche désigne une voiture,
                                    dans l'autre elle ne désigne rien. */}
                                {t.client.vehicleNote ? (
                                  <div className={s.tkfwarn}>{t.client.vehicleNote}</div>
                                ) : t.client.modsTotal > 0 ? (
                                  <div className={s.tkfmods}>
                                    {t.client.mods.map((m) => (
                                      <span key={m} className={s.tkfmod}>
                                        {m}
                                      </span>
                                    ))}
                                    <span className={s.tkfcount}>{t.client.modsTotal} mod.</span>
                                  </div>
                                ) : (
                                  <div className={s.tkfstock}>Véhicule d&apos;origine</div>
                                )}
                              </div>
                            ) : null}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className={s.wrail}>
              <Card
                className={`${s.chartCard} ${s.chartRail} rounded-[var(--r)] border border-border ring-0`}
              >
                <CardHeader className="grid-cols-1">
                  <CardTitle>Son profil par rayon</CardTitle>
                  <CardDescription>
                    {mixPrevTotalCents > 0
                      ? "Cette période, superposée à la précédente"
                      : "Cette période"}
                  </CardDescription>
                </CardHeader>
                <CardContent className={s.chartBody}>
                  {mixHasData ? (
                    <MixChart data={mix} className={`${s.chartRailFill} aspect-auto w-full`} />
                  ) : (
                    <p className="pick">Aucun article vendu sur cette période.</p>
                  )}
                </CardContent>
                {/* ⚠ LE PIED PARLE DE LA FORME, PAS DU CHIFFRE. Une variation de chiffre est déjà
                    écrite en figure, et surtout elle CONTREDIRAIT la carte un jour sur deux: le
                    radar compare deux PROFILS (des parts par rayon), donc un vendeur peut avoir
                    exactement le même profil avec deux fois moins de chiffre, et l'inverse. Le pied
                    nomme donc le rayon dominant et dit s'il l'était déjà. */}
                <CardFooter>
                  <div className={s.cardTrend}>
                    {leader ? (
                      <b>
                        {leader.label} domine avec {pct(leader.cur, mixCurTotalCents)} % de son chiffre
                        {mixPrevTotalCents > 0
                          ? `, contre ${pct(leader.prev, mixPrevTotalCents)} % la période précédente`
                          : ""}
                      </b>
                    ) : (
                      <b>Aucun rayon vendu sur cette période</b>
                    )}
                    <em>{rangeLabel}</em>
                  </div>
                </CardFooter>
              </Card>

              {showHours ? (
                <Card
                  className={`${s.chartCard} ${s.chartRail} rounded-[var(--r)] border border-border ring-0`}
                >
                  <CardHeader className="grid-cols-1">
                    <CardTitle>Heures par jour</CardTitle>
                    <CardDescription>
                      {/* Le rendement est un RATIO: il s'écrit, il ne se compare pas en hauteur.
                          Voir `HoursBarChart` pour pourquoi il n'y a pas de second axe. */}
                      {workedSeconds > 0 && totalCents > 0
                        ? `${money(Math.round(totalCents / (workedSeconds / SECONDS_PER_HOUR)))} par heure en moyenne`
                        : "Aucune heure pointée sur la période"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className={s.chartBody}>
                    {hoursHasData ? (
                      <HoursBarChart data={hours} className={`${s.chartRailFill} aspect-auto w-full`} />
                    ) : (
                      <p className="pick">Aucun pointage sur cette période.</p>
                    )}
                  </CardContent>
                </Card>
              ) : null}

              {showHours ? (
                <div className={`panel ${s.absorb}`}>
                  <div className="ph">
                    <span className="cap">Ses pointages</span>
                    <span className="dim">
                      {shifts.length} service{shifts.length > 1 ? "s" : ""}
                    </span>
                  </div>
                  {shiftsTruncated ? (
                    <p className="pick">Seuls les services les plus récents sont listés.</p>
                  ) : null}
                  {shifts.length === 0 ? (
                    <Empty className="p-4">
                      <EmptyMedia variant="icon">
                        <Clock strokeWidth={1.75} aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyDescription>Aucun service sur la période.</EmptyDescription>
                    </Empty>
                  ) : (
                    <div className={s.scroll}>
                      <div className={s.rows}>
                        {shifts.map((sh) => (
                          <div className={s.row} key={sh.id}>
                            <span className={s.rmain}>
                              <span className={s.grade}>{sh.day}</span>
                              <span className={s.shrange}>{sh.range}</span>
                              <span className={`${s.shwhy} ${sh.open ? s.live : ""}`}>{sh.why}</span>
                            </span>
                            <span className={s.ra}>{hoursLabel(sh.seconds)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}
