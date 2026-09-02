import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug, type BusinessAccess } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { employeesForJob } from "@/lib/business/roster";
import { dailyTotals, listSales, sellerTotals } from "@/lib/business/sales";
import { templateMeasuresCost } from "@/lib/business/templates";
import { realProfitForJob, type RealProfit } from "@/lib/business/realProfit";
import { listShifts, onDutyNow, shiftTotals } from "@/lib/business/shifts";
import { gradesForJob } from "@/lib/data/gameCommands";
import { parsePeriod, periodDays, type Period } from "./periods";
import EquipeView, {
  type DayCell,
  type DutyRow,
  type FeedRow,
  type TeamRow,
} from "./EquipeView";

export const dynamic = "force-dynamic";

/**
 * ⚠ Même seuil que `SHIFT_STALE_MS` dans lib/business/access.ts (non exporté, donc dupliqué ici
 * volontairement, exactement comme la page Pointage le fait déjà et pour la même raison): un
 * pointage ouvert dont le heartbeat a plus de cinq minutes ne doit pas apparaître "en service" ici
 * alors que le rail de navigation, à côté, a déjà considéré la personne hors ligne. Deux surfaces
 * qui se contredisent sur qui travaille en ce moment sont pires que l'absence de l'information.
 */
const SHIFT_STALE_MS = 5 * 60_000;

/**
 * Le nombre de POINTAGES parcourus pour retrouver le grade de chacun.
 *
 * ⚠ Ce plafond ne borne AUCUN total. Les heures viennent de `shiftTotals`, agrégé en SQL et donc
 * exact quoi qu'il arrive; cette lecture-ci ne sert qu'à récupérer le grade porté par la ligne de
 * pointage la plus récente de chaque personne. Une troncature ne fausse donc pas un chiffre, elle
 * laisse au pire un grade inconnu, ce que le relevé affiche en toutes lettres.
 */
const SHIFT_SCAN_LIMIT = 1000;

/**
 * Le nombre de VENTES lues au détail, POUR LE FIL DU RAIL ET RIEN D'AUTRE.
 *
 * ⚠⚠ CE PLAFOND NE PEUT PLUS FAUSSER UN GRAPHIQUE, ET C'EST LE COEUR DE LA CORRECTION DU
 * 2026-08-09. Cette page construisait son rythme jour par jour en additionnant `listSales(...)`,
 * une lecture d'AFFICHAGE plafonnée qui rend les ventes de la plus récente à la plus ancienne:
 * au-delà du plafond, ce sont les premiers jours de la période qui manquaient, et l'histogramme
 * montrait un début de semaine creux qui n'avait jamais eu lieu. La page le détectait
 * (`rhythmUnavailable`) et refusait alors de tracer, ce qui était le bon réflexe mais laissait le
 * commerce le plus actif du serveur sans aucun graphique: sur ~1 300 ventes en onze jours,
 * le message "trop de ventes sur cette période" était l'affichage NORMAL.
 *
 * Le rythme vient désormais de `dailyTotals`, qui agrège en SQL sur TOUTES les lignes de la
 * période. `listSales` ne sert plus qu'à choisir quels tickets montrer dans le fil, où un plafond
 * est la bonne réponse: on affiche les plus récents parce que c'est un fil, pas un total.
 */
const FEED_LIMIT = 40;

/** Les jours d'une fenêtre glissante ne peuvent pas dépasser la plus longue période offerte. */
const MAX_DAYS = 62;

const DAYS_IN_WEEK = 7;

/** Au-delà de sept jours, une abscisse porte une date courte plutôt qu'un nom de jour. */
const WEEKDAY_AXIS_UP_TO = DAYS_IN_WEEK;

/** Le lundi 00:00 de la semaine qui contient `d`. */
function mondayOf(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay(); // 0 = dimanche
  const back = day === 0 ? 6 : day - 1;
  out.setDate(out.getDate() - back);
  return out;
}

function startOfToday(): Date {
  const out = new Date();
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Les bornes [from, to) de la période demandée.
 *
 * ⚠ DEUX FAMILLES DE FENÊTRES, ET ELLES NE SE CALCULENT PAS PAREIL. "Semaine en cours" et "semaine
 * dernière" sont des semaines CALENDAIRES (lundi au lundi): leur longueur vient du calendrier, et
 * c'est ce qui permet de dire "lundi" en abscisse. "14/30 derniers jours" sont des fenêtres
 * GLISSANTES qui se terminent à MINUIT PROCHAIN, pas à l'instant présent: sans ça, la dernière
 * colonne du graphique serait une journée à moitié écoulée comparée à des journées entières, et
 * elle aurait l'air d'un effondrement tous les matins.
 */
function periodRange(period: Period): { from: Date; to: Date } {
  if (period === "cur" || period === "prev") {
    const curStart = mondayOf(new Date());
    if (period === "cur") {
      const to = new Date(curStart);
      to.setDate(to.getDate() + DAYS_IN_WEEK);
      return { from: curStart, to };
    }
    const from = new Date(curStart);
    from.setDate(from.getDate() - DAYS_IN_WEEK);
    return { from, to: curStart };
  }
  const to = startOfToday();
  to.setDate(to.getDate() + 1);
  const from = new Date(to);
  from.setDate(from.getDate() - periodDays(period));
  return { from, to };
}

/**
 * Le nombre de jours d'une fenêtre, compté en AVANÇANT LA DATE.
 *
 * ⚠ Jamais `(to - from) / 86 400 000`. Le passage à l'heure d'été fait des journées de 23 et de 25
 * heures: une semaine de mars vaut 167 heures, donc la division rendrait 6,96 jours, tronqué à 6.
 * La semaine perdrait une colonne, une fois par an, sur un seul écran.
 */
function dayCount(range: { from: Date; to: Date }): number {
  let n = 0;
  const cur = new Date(range.from);
  while (cur.getTime() < range.to.getTime() && n < MAX_DAYS) {
    cur.setDate(cur.getDate() + 1);
    n++;
  }
  return n;
}

/**
 * La fenêtre de MÊME LONGUEUR qui précède immédiatement celle-là, pour la tendance.
 *
 * Dérivée de la borne basse et non recalculée depuis aujourd'hui: c'est ce qui fait que la
 * comparaison reste juste quand on regarde "semaine dernière" (on la compare alors à l'avant-
 * dernière, pas à la semaine en cours).
 */
function previousOf(range: { from: Date; to: Date }): { from: Date; to: Date } {
  const from = new Date(range.from);
  from.setDate(from.getDate() - dayCount(range));
  return { from, to: range.from };
}

const WEEKDAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
const SHORTDATE_FMT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "numeric" });
const FULLDAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

function upper1(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * La clé d'un jour, dans la MÊME forme que celle rendue par `dailyTotals`
 * (`DATE_FORMAT(declared_at, '%Y-%m-%d')`, voir sales.ts).
 *
 * ⚠ Construite avec les accesseurs LOCAUX, jamais avec `toISOString()`. Ce dernier convertit en UTC
 * avant de découper: à Toronto, tout ce qui est déclaré après 20h bascule sur le lendemain, donc
 * une soirée entière de bar tomberait dans la colonne du jour suivant. La colonne SQL est une
 * heure locale naïve (voir `localDatetime` dans lib/db/types.ts) et MySQL la découpe en local: les
 * deux côtés doivent donc parler la même langue, sinon le rapprochement par clé rate EN SILENCE et
 * le graphique s'affiche entièrement à zéro. Le rapprochement compte désormais ses échecs et les
 * journalise, voir la boucle plus bas.
 */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Les jours de la période, chacun avec sa clé SQL, son étiquette d'axe et son intitulé de bulle. */
function dayList(from: Date, count: number, markToday: boolean): DayCell[] {
  const now = Date.now();
  const out: DayCell[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    out.push({
      key: dayKey(d),
      label:
        count <= WEEKDAY_AXIS_UP_TO
          ? upper1(WEEKDAY_FMT.format(d).replace(".", ""))
          : SHORTDATE_FMT.format(d),
      full: upper1(FULLDAY_FMT.format(d)),
      // "Aujourd'hui" n'existe que dans une fenêtre qui contient aujourd'hui: le marquer sur la
      // semaine dernière désignerait un jour révolu comme le jour courant.
      today: markToday && now >= d.getTime() && now < next.getTime(),
      cents: 0,
    });
  }
  return out;
}

const DATETIME_FMT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Pourquoi `team.read` échoue, dans l'ordre où `businessCan` la refuserait.
 *
 * Le rail de navigation (layout.tsx) ne montre ce lien que module allumé ET capacité accordée, donc
 * la seule raison qu'il affiche est "en jeu". Cette page reste joignable directement par URL, où les
 * trois raisons redeviennent possibles.
 */
function deniedReason(access: BusinessAccess): string {
  if (access.modules.equipe === false) {
    return "Ce module n'est pas activé pour ce commerce.";
  }
  if (!access.capabilities.has(CAP.TEAM_READ)) {
    return "Votre grade ne donne pas accès aux chiffres de l'équipe.";
  }
  return "Consultable en jeu : connectez votre personnage pour voir l'équipe.";
}

/**
 * ÉQUIPE: le rendement de chaque employé, pour la période choisie.
 *
 * ⚠ La page re-résout l'accès elle-même: la mise en page parente n'est pas une frontière de
 * sécurité, et un Server Action (ou une navigation client) peut atteindre cette route sans jamais
 * repasser par `layout.tsx`.
 */
export default async function EquipePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canRead = businessCan(access, CAP.TEAM_READ);
  const sp = await searchParams;
  const period = parsePeriod(sp.p);
  const showHours = access.modules.pointage !== false;
  const showCommission = access.modules.commissions !== false;
  /**
   * ⚠ LE BENEFICE NE S'AFFICHE QUE LA OU IL EST MESURE (`templateMeasuresCost`). Un bar n'a aucun
   * cout de revient enregistre: son `margin_cents` vaut 0 pour toujours, et l'afficher dirait a son
   * patron qu'il vend a prix coutant.
   */
  const showMargin = templateMeasuresCost(access.template);

  let rows: TeamRow[] = [];
  let days: DayCell[] = [];
  let feed: FeedRow[] = [];
  let dutyRows: DutyRow[] = [];
  let prevTotalCents = 0;
  let currentCount = 0;
  let formerCount = 0;
  /**
   * LE VRAI RESULTAT, lu dans le grand livre du jeu. Voir realProfit.ts pour pourquoi il remplace le
   * benefice tire des tickets declares sur CETTE figure: les tickets disent ce qu'on a declare
   * vendre, le grand livre dit ce que l'entreprise a reellement encaisse et depense.
   */
  let realProfit: RealProfit | null = null;

  if (canRead) {
    const range = periodRange(period);
    const prev = previousOf(range);

    const [sales, prevSales, hours, duty, shiftRows, ladder, feedSales, perDay, roster, ledger] = await Promise.all([
      sellerTotals(access.businessId, range),
      // La période précédente sert UNIQUEMENT à la tendance, donc l'agrégat suffit: pas un ticket
      // n'est chargé pour ça.
      sellerTotals(access.businessId, prev),
      // Requête sautée si les heures ne s'affichent pas: aucune raison de la payer pour rien montrer.
      showHours ? shiftTotals(access.job, range) : Promise.resolve([]),
      // "En service" est une question de MAINTENANT, indépendante de la période ET du module
      // `pointage`: ce dernier gouverne l'affichage des heures, pas celui de la présence.
      onDutyNow(access.job, SHIFT_STALE_MS),
      listShifts(access.job, { ...range, limit: SHIFT_SCAN_LIMIT }),
      gradesForJob(access.job),
      // Le fil du rail, et lui seul: un plafond y est la bonne réponse (voir FEED_LIMIT).
      listSales(access.businessId, { ...range, limit: FEED_LIMIT }),
      /**
       * LE RYTHME, PAR JOUR ET PAR PERSONNE, EN UNE SEULE REQUÊTE.
       *
       * `bySeller` sert DEUX surfaces d'un coup: la courbe empilée de l'équipe (somme des vendeurs
       * pour chaque jour) et le mini-graphique de chaque ligne du relevé. Demander l'agrégat global
       * puis un agrégat par personne serait deux requêtes pour la même somme, et surtout deux
       * sources qui pourraient un jour ne plus s'accorder au centime.
       */
      dailyTotals(access.businessId, range, { bySeller: true }),
      /**
       * L'EFFECTIF, ET IL NE VIENT D'AUCUNE DES LECTURES CI-DESSUS.
       *
       * ⚠⚠ Les huit requêtes précédentes rendent toutes de l'ACTIVITÉ (a vendu, a pointé, est en
       * service). Leur union n'est pas une équipe: quelqu'un qui tient le métier sans avoir rien
       * vendu ni pointé n'apparaît dans aucune, donc n'existait pas sur cette page. Voir
       * `lib/business/roster.ts`, et pourquoi le rapprochement se fait par `Map` et jamais en SQL
       * (collations incompatibles entre `citadel_*` et les tables ESX).
       */
      employeesForJob(access.job),
      /**
       * LE GRAND LIVRE DU JEU, sur la MEME periode que le reste de la page.
       *
       * ⚠ Il ne remplace aucune des lectures ci-dessus et ne s'additionne a aucune: elles decrivent
       * ce que l'equipe a DECLARE, celle-ci ce que la caisse a REELLEMENT fait. Les deux
       * divergent - c'est l'information, pas un defaut a lisser.
       */
      showMargin ? realProfitForJob(access.job, range) : Promise.resolve(null),
    ]);
    realProfit = ledger;

    const gradeLabels = new Map(ladder.map((g) => [g.grade, g.label]));
    currentCount = roster.length;

    /**
     * LE GRADE VU DEPUIS LES POINTAGES: un INSTANTANÉ daté, désormais RÉSERVÉ AUX ANCIENS EMPLOYÉS.
     *
     * `lifeinvader_business_shifts.grade` est copié à la prise de service, donc il dit le grade qu'une
     * personne avait ce jour-là, pas celui qu'elle a. Cette page s'en servait pour TOUT LE MONDE
     * faute de savoir lire l'annuaire; `employeesForJob` le lit maintenant, et le grade courant
     * l'emporte pour quiconque tient encore le métier. Il ne reste que le cas où l'annuaire ne dit
     * plus rien, celui de quelqu'un qui est parti: cet instantané est alors la seule source qui
     * existe (voir la boucle de résolution plus bas).
     *
     * Un service OUVERT est forcément le plus récent, donc `duty` passe en premier et gagne.
     */
    const gradeOf = new Map<string, number>();
    for (const d of duty) if (!gradeOf.has(d.identifier)) gradeOf.set(d.identifier, d.grade);
    for (const sh of shiftRows) if (!gradeOf.has(sh.identifier)) gradeOf.set(sh.identifier, sh.grade);

    const dutySeconds = new Map<string, number>();
    for (const d of duty) if (!dutySeconds.has(d.identifier)) dutySeconds.set(d.identifier, d.seconds);

    const prevTotals = new Map(prevSales.map((r) => [r.sellerIdentifier, r.totalCents]));
    prevTotalCents = prevSales.reduce((acc, r) => acc + r.totalCents, 0);

    days = dayList(range.from, dayCount(range), period === "cur" || period === "d14" || period === "d30");
    const dayIndex = new Map(days.map((d, i) => [d.key, i]));

    /**
     * ⚠ RANGÉ PAR CLÉ, PAS PAR COMPARAISON D'INSTANTS. La somme vient de `DATE(declared_at)` en
     * SQL: la ranger dans la colonne dont la clé est cette même chaîne rend le découpage
     * IDENTIQUE des deux côtés par construction, y compris les deux nuits par an où l'heure d'été
     * fait des journées de 23 et de 25 heures. Une clé inconnue est ignorée, ce qui ne peut arriver
     * que si la requête et cette liste divergeaient sur les bornes de la période.
     */
    /**
     * ⚠ UNE CLÉ QUI NE TOMBE DANS AUCUNE COLONNE EST SIGNALÉE, PAS AVALÉE. Le rapprochement entre
     * `dailyTotals` (qui rend `DATE_FORMAT(..., '%Y-%m-%d')`) et `dayList` (qui construit la même
     * chaîne en JS) est une convention de FORMAT partagée par deux fichiers, donc précisément le
     * genre de contrat qui casse en silence: si l'un des deux côtés change de forme, la Map ne
     * trouve plus rien, chaque journée vaut zéro et le graphique s'affiche parfaitement plat. Ça
     * ressemble à "aucune vente", pas à une panne, et personne ne peut le contredire de mémoire.
     * Un compteur plus une ligne de journal coûtent trois lignes et suppriment toute une classe de
     * bug muet. (C'est déjà arrivé: `DATE()` rendait un objet `Date`, voir sales.ts.)
     */
    const perPerson = new Map<string, number[]>();
    let unmatchedDays = 0;
    for (const cell of perDay) {
      const idx = dayIndex.get(cell.day);
      if (idx === undefined) {
        unmatchedDays++;
        continue;
      }
      if (cell.sellerIdentifier === null) continue;
      let series = perPerson.get(cell.sellerIdentifier);
      if (!series) {
        series = new Array<number>(days.length).fill(0);
        perPerson.set(cell.sellerIdentifier, series);
      }
      series[idx] = (series[idx] ?? 0) + cell.totalCents;
      days[idx]!.cents += cell.totalCents;
    }
    if (unmatchedDays > 0) {
      console.warn(
        `[equipe] ${unmatchedDays} agrégat(s) journalier(s) hors des colonnes de la période`,
        { businessId: access.businessId, period, sample: perDay[0]?.day, colonnes: days[0]?.key },
      );
    }

    /**
     * JOINTURE EN MÉMOIRE, jamais en SQL: lifeinvader_business_sales (collation du panel, utf8mb4_general_ci) et les
     * pointages n'ont pas à être rapprochés en base ici, et de toute façon `sellerTotals`/
     * `shiftTotals` sont deux requêtes déjà cloisonnées chacune de son côté. Une Map par
     * identifiant est le seul rapprochement demandé.
     */
    const byIdentifier = new Map<string, TeamRow>();
    const blank = (identifier: string, name: string): TeamRow => ({
      identifier,
      name,
      gradeLabel: null,
      former: false,
      sales: 0,
      totalCents: 0,
      commissionCents: 0,
      marginCents: 0,
      seconds: 0,
      prevTotalCents: prevTotals.get(identifier) ?? 0,
      onDutySeconds: dutySeconds.get(identifier) ?? null,
      days: perPerson.get(identifier) ?? new Array<number>(days.length).fill(0),
    });

    /**
     * L'EFFECTIF D'ABORD, L'ACTIVITÉ ENSUITE, ET L'ORDRE COMPTE.
     *
     * ⚠ Poser les employés AVANT de lire les agrégats donne à chacun une ligne à VRAIS ZÉROS
     * (0 vente, 0 h, 0 $), qui est une information et non un trou: "cette personne n'a rien fait
     * cette semaine" est précisément ce qu'un gérant vient chercher. Les boucles suivantes se
     * contentent alors de remplir; aucune n'a plus à créer une ligne pour quelqu'un qui travaille
     * ici, et il n'y a donc plus d'ordre de lecture dans lequel un employé peut se perdre.
     */
    for (const m of roster) {
      const row = blank(m.identifier, m.name);
      row.gradeLabel = m.gradeLabel;
      byIdentifier.set(m.identifier, row);
    }

    /**
     * ⚠ `upsert` ET NON `set`: une ligne posée par l'effectif porte déjà le grade COURANT, lu dans
     * l'annuaire du jeu. La remplacer par une ligne neuve construite depuis un agrégat de vente
     * effacerait ce grade et le remplacerait par l'instantané daté du dernier pointage, c'est-à-dire
     * une régression silencieuse vers ce que cette page affichait avant l'effectif.
     *
     * Le nom, lui, est celui de l'ANNUAIRE quand la personne y figure: `sellerName` et le `name`
     * d'un pointage sont des copies datées prises au moment de l'écriture, donc un employé renommé
     * en jeu s'afficherait sous son ancien nom. Pour un ancien employé, cette copie datée est au
     * contraire la SEULE identité qui reste, et c'est bien elle qu'on garde.
     */
    const upsert = (identifier: string, name: string): TeamRow => {
      const existing = byIdentifier.get(identifier);
      if (existing) return existing;
      const row = blank(identifier, name);
      // Absent de l'effectif du jour: la personne a été active pendant la période et ne tient plus
      // ce métier. On la montre quand même, en retrait. Ses chiffres sont des faits.
      row.former = true;
      byIdentifier.set(identifier, row);
      return row;
    };

    for (const s of sales) {
      const row = upsert(s.sellerIdentifier, s.sellerName);
      row.sales = s.sales;
      row.totalCents = s.totalCents;
      row.commissionCents = s.commissionCents;
      row.marginCents = s.marginCents;
    }
    // Un pointage sans vente compte quand même comme une ligne d'équipe: quelqu'un qui a pris son
    // service sans encore rien déclarer reste un employé de la période, pas un absent.
    for (const sh of hours) {
      upsert(sh.identifier, sh.name).seconds = sh.seconds;
    }
    /**
     * ⚠ Quelqu'un en service EN CE MOMENT et absent des deux agrégats n'apparaît que sur une
     * fenêtre qui contient aujourd'hui. Sur "semaine dernière", l'ajouter ferait figurer dans un
     * bilan passé une personne qui n'y a rien fait, au seul motif qu'elle travaille aujourd'hui: le
     * relevé cesserait de décrire la période qu'il annonce. Sur une fenêtre courante, au contraire,
     * l'omettre serait faux dans l'autre sens (le rail dit "en service", la page dit qu'il n'y a
     * personne).
     */
    if (period !== "prev") {
      for (const d of duty) upsert(d.identifier, d.name);
    }

    /**
     * LE GRADE D'UN ANCIEN EMPLOYÉ, ET POURQUOI CE N'EST PAS "GRADE 0".
     *
     * Un employé actuel porte le grade de l'annuaire, déjà posé plus haut. Quelqu'un qui ne tient
     * plus le métier n'en a plus AUCUN à lire: la meilleure source restante est l'instantané copié
     * sur sa ligne de pointage la plus récente (`lifeinvader_business_shifts.grade`), exactement ce que
     * cette page utilisait pour tout le monde avant l'effectif.
     *
     * ⚠ SANS INSTANTANÉ, ON N'ÉCRIT PAS DE GRADE DU TOUT. `0` est un VRAI grade ici (Recrue, porté
     * par un employé réel du vigneron), donc s'en servir comme valeur "inconnu" affirmerait un rang
     * que la base ne dit nulle part. La ligne porte alors sa seule étiquette honnête, "Ancien
     * employé", et rien d'autre.
     */
    for (const row of byIdentifier.values()) {
      if (!row.former) continue;
      const grade = gradeOf.get(row.identifier);
      row.gradeLabel = grade === undefined ? null : (gradeLabels.get(grade) ?? `Grade ${grade}`);
    }

    formerCount = [...byIdentifier.values()].filter((r) => r.former).length;

    /**
     * ⚠ LES EMPLOYÉS ACTUELS D'ABORD, LES ANCIENS APRÈS, PUIS LE CLASSEMENT HABITUEL À L'INTÉRIEUR
     * DE CHAQUE GROUPE. Un relevé mélangé ferait remonter au premier rang quelqu'un qui a quitté le
     * commerce mercredi, au-dessus de l'équipe qui y travaille aujourd'hui, alors que la question
     * posée par cette page est "comment va mon équipe". Les chiffres de l'ancien restent EXACTS et
     * comptent dans tous les totaux: une vente qui a eu lieu a eu lieu.
     */
    rows = [...byIdentifier.values()].sort(
      (a, b) =>
        Number(a.former) - Number(b.former) ||
        b.totalCents - a.totalCents ||
        b.seconds - a.seconds ||
        a.name.localeCompare(b.name, "fr"),
    );

    feed = feedSales.map((sale) => ({
      id: sale.id,
      seller: sale.sellerName,
      when: DATETIME_FMT.format(sale.declaredAt),
      totalCents: sale.totalCents,
    }));

    dutyRows = duty.map((d) => ({ identifier: d.identifier, name: d.name, seconds: d.seconds }));
  }

  return (
    <EquipeView
      slug={access.slug}
      name={access.name}
      period={period}
      canRead={canRead}
      deniedReason={canRead ? null : deniedReason(access)}
      showHours={showHours}
      showCommission={showCommission}
      showMargin={showMargin}
      realProfit={realProfit}
      rows={rows}
      days={days}
      feed={feed}
      duty={dutyRows}
      prevTotalCents={prevTotalCents}
      currentCount={currentCount}
      formerCount={formerCount}
    />
  );
}
