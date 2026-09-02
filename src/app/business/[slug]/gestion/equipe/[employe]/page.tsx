import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug, type BusinessAccess } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { listItems } from "@/lib/business/catalogue";
import { employeesForJob } from "@/lib/business/roster";
import { dailyTotals, listSales, saleLines, sellerTotals, topProducts } from "@/lib/business/sales";
import { clientRecordView } from "@/lib/business/clientRecord";
import { templateMeasuresCost } from "@/lib/business/templates";
import { listShifts, onDutyNow, shiftTotals } from "@/lib/business/shifts";
import { gradesForJob } from "@/lib/data/gameCommands";
import { type HourPoint, type MixPoint } from "../SalesChart";
import { parsePeriod, periodDays, type Period } from "../periods";
import EmployeView, {
  type DayCell,
  type ShiftView,
  type TicketView,
  type TopProduct,
} from "./EmployeView";

export const dynamic = "force-dynamic";

/** ⚠ Même seuil que `SHIFT_STALE_MS` dans lib/business/access.ts (non exporté), même raison que sur
 *  la page Équipe: deux surfaces qui se contredisent sur qui est en service sont pires que rien. */
const SHIFT_STALE_MS = 5 * 60_000;

/**
 * Le nombre de TICKETS listés, et le nombre de POINTAGES listés.
 *
 * ⚠⚠ CE PLAFOND NE FAUSSE PLUS AUCUN CHIFFRE, ET C'EST LA CORRECTION DU 2026-08-09. Cette page
 * calculait TOUS ses totaux (chiffre déclaré, part à percevoir, articles vendus, rythme jour par
 * jour) en additionnant les tickets rendus par `listSales`, une lecture d'affichage plafonnée à 500
 * qui rend les ventes de la plus récente à la plus ancienne. Au-delà du plafond, le chiffre affiché
 * n'était donc plus celui de la période mais celui des 500 derniers tickets, et le graphique était
 * carrément refusé (`ticketsTruncated`). Sur le commerce réel du serveur, un vendeur à ~770 ventes
 * en onze jours passait cette borne sans que rien d'autre qu'un encart le signale.
 *
 * Tout ce qui est un TOTAL vient maintenant d'un agrégat SQL (`sellerTotals`, `dailyTotals`,
 * `topProducts`, `shiftTotals`) porté sur toutes les lignes de la période. Ce plafond ne gouverne
 * plus qu'une chose: combien de tickets le fil affiche. Un fil est fait pour être plafonné.
 *
 * ⚠ Il borne aussi le nombre d'appels à `saleLines`, qui n'a pas de forme "plusieurs ventes à la
 * fois" (lu dans sales.ts, jamais réécrit ici). L'ancienne version en lançait un PAR TICKET DE LA
 * PÉRIODE, donc jusqu'à 500 requêtes pour afficher une page; il y en a désormais au plus 40, une
 * par ticket réellement dessiné.
 */
const TICKET_FEED = 40;
const SHIFT_LIMIT = 200;

/** Les articles distincts montrés dans "Ce qu'il vend le plus". Au-delà, ce n'est plus un classement. */
const TOP_PRODUCTS = 12;

/**
 * Les rayons portés par le radar de profil.
 *
 * Au-delà, la toile devient un cercle: les axes se touchent, les étiquettes se chevauchent et la
 * forme cesse d'être comparable d'un employé à l'autre. On garde les rayons les plus vendus.
 */
const MIX_MAX_AXES = 8;

const DAYS_IN_WEEK = 7;
const WEEKDAY_AXIS_UP_TO = DAYS_IN_WEEK;
const MAX_DAYS = 62;

/** Le lundi 00:00 de la semaine qui contient `d`. Dupliqué depuis ../page.tsx à dessein: chaque
 *  page de ce portail re-résout tout elle-même, y compris ce calcul, plutôt que de dépendre d'un
 *  fichier voisin qui pourrait changer sous elle. (Les OPTIONS de période, elles, sont partagées
 *  via `../SalesChart`: le menu écrit une valeur que le serveur relit, donc deux listes qui
 *  divergeraient seraient un bug, pas une précaution. Voir `PERIOD_OPTIONS`.) */
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

/** Les bornes [from, to) de la période demandée. Voir ../page.tsx pour les deux familles. */
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

/** Le nombre de jours d'une fenêtre, compté en avançant la DATE (l'heure d'été, voir ../page.tsx). */
function dayCount(range: { from: Date; to: Date }): number {
  let n = 0;
  const cur = new Date(range.from);
  while (cur.getTime() < range.to.getTime() && n < MAX_DAYS) {
    cur.setDate(cur.getDate() + 1);
    n++;
  }
  return n;
}

/** La fenêtre de même longueur qui précède immédiatement celle-là, dérivée de sa borne basse. */
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

/** La clé d'un jour, dans la MÊME forme que celle rendue par `dailyTotals`
 *  (`DATE_FORMAT(declared_at, '%Y-%m-%d')`). Voir ../page.tsx pour pourquoi `toISOString()` serait
 *  faux ici (il bascule le soir sur le lendemain). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
      today: markToday && now >= d.getTime() && now < next.getTime(),
      mine: 0,
      team: 0,
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
const DAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
const TIME_FMT = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function fmtDay(d: Date): string {
  return upper1(DAY_FMT.format(d));
}

/** Les valeurs réelles de `lifeinvader_business_shifts.ended_reason` (schema/citadel.ts), en français. */
const ENDED_REASON_LABEL: Record<string, string> = {
  debauche: "Fin de service",
  deconnexion: "Déconnexion",
  afk: "Inactivité",
  crash_sweep: "Coupure serveur",
  job_change: "Changement de métier",
};

/** Même raisonnement que ../page.tsx: la seule raison affichée par le rail est "en jeu", mais une
 *  URL directe peut retomber sur les trois. */
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
 * FICHE EMPLOYÉ: son profil de vente, ses tickets, ses pointages, pour ce commerce.
 *
 * ⚠⚠ `employe` VIENT DE L'URL ET N'EST PAS UN DROIT. Il n'est résolu qu'à partir de lignes déjà
 * cloisonnées par `businessId`/`job` (`listSales`, `listShifts`): si aucune n'existe pour cet
 * identifiant dans CE commerce, `notFound()`. Sans ce contrôle, détenir `team.read` dans UN SEUL
 * commerce suffirait à lire les gains de n'importe quel joueur du serveur en collant son identifiant
 * dans l'URL - `team.read` autorise à voir SON équipe, pas le reste du serveur.
 */
export default async function EmployePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; employe: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { slug, employe } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canRead = businessCan(access, CAP.TEAM_READ);
  const sp = await searchParams;
  const period = parsePeriod(sp.p);
  const showHours = access.modules.pointage !== false;
  const showCommission = access.modules.commissions !== false;
  /**
   * ⚠ LE BENEFICE NE S'AFFICHE QUE LA OU IL EST MESURE. Voir `templateMeasuresCost`: un bar n'a
   * aucun cout de revient enregistre, donc son `margin_cents` vaut 0 pour toujours, et afficher
   * "Benefice 0 $" a son patron affirmerait qu'il vend a prix coutant.
   */
  const showMargin = templateMeasuresCost(access.template);

  if (!canRead) {
    // Pas le droit: on ne cherche même pas si `employe` existe. Faire la vérification quand même
    // révélerait, par le simple délai ou par un futur changement de comportement, l'existence d'un
    // employé à quelqu'un qui n'a pas le droit de le savoir.
    return (
      <EmployeView
        slug={access.slug}
        identifier={employe}
        name={null}
        gradeLabel={null}
        former={false}
        period={period}
        canRead={false}
        deniedReason={deniedReason(access)}
        showHours={showHours}
        showCommission={showCommission}
        onDutySeconds={null}
        showMargin={showMargin}
        totalCents={0}
        commissionCents={0}
        marginCents={0}
        prevTotalCents={0}
        salesCount={0}
        teamTotalCents={0}
        teamHeadcount={0}
        workedSeconds={0}
        itemsSold={0}
        distinctProducts={0}
        products={[]}
        mix={[]}
        mixPrevTotalCents={0}
        tickets={[]}
        ticketsTotal={0}
        shifts={[]}
        hours={[]}
        days={[]}
        shiftsTruncated={false}
      />
    );
  }

  /**
   * APPARTENANCE AU COMMERCE, SANS BORNE DE DATE et INDÉPENDANTE de `showHours`: un employé embauché
   * la semaine dernière et sans aucune activité cette semaine reste un employé, et la vérification
   * de sécurité ne doit pas s'affaiblir parce que l'affichage des heures est éteint.
   *
   * ⚠⚠ TROIS PREUVES, PAS DEUX, ET LA TROISIÈME CORRIGE UN 404 RÉEL. Les deux sondes d'activité
   * suffisaient tant que la page Équipe ne listait QUE des gens actifs. Depuis qu'elle liste
   * l'effectif complet, elle affiche des lignes cliquables pour des employés à zéro vente et zéro
   * pointage: sans `employeesForJob`, chacun de ces liens mène à une page introuvable, et le patron
   * conclut que le portail est cassé. Constaté sur le vigneron avant correction (David Choukroune,
   * grade 0, aucune activité).
   *
   * ⚠ LA PORTE NE S'ÉLARGIT PAS POUR AUTANT. Les trois lectures sont déjà cloisonnées: `listSales`
   * par `businessId`, `listShifts` et `employeesForJob` par le `job` du commerce, tous trois issus
   * du `BusinessAccess` résolu plus haut. Détenir `team.read` dans UN commerce ne permet donc
   * toujours pas de lire un joueur quelconque du serveur en collant son identifiant dans l'URL: il
   * faut qu'il travaille ICI, maintenant ou pendant la période.
   */
  const [anySale, anyShift, roster] = await Promise.all([
    listSales(access.businessId, { seller: employe, limit: 1 }),
    listShifts(access.job, { identifier: employe, limit: 1 }),
    employeesForJob(access.job),
  ]);
  const member = roster.find((m) => m.identifier === employe) ?? null;
  if (anySale.length === 0 && anyShift.length === 0 && member === null) notFound();

  const range = periodRange(period);
  const prev = previousOf(range);

  const [
    sellerRows,
    prevRows,
    perDay,
    productRows,
    prevProductRows,
    sales,
    shifts,
    hourRows,
    duty,
    items,
    ladder,
  ] = await Promise.all([
    // Le classement de la période, pour SON chiffre exact ET pour sa part d'équipe: deux lectures
    // que la même requête sert, plutôt qu'un total par personne recalculé deux fois.
    sellerTotals(access.businessId, range),
    sellerTotals(access.businessId, prev),
    // Jour par jour, tout le commerce et par personne: la courbe empilée "lui / reste de l'équipe"
    // se construit entièrement là-dedans, sans une seconde requête pour le total.
    dailyTotals(access.businessId, range, { bySeller: true }),
    topProducts(access.businessId, range, employe),
    // Le profil de la période précédente ne sert QU'au radar de comparaison. C'est un agrégat SQL,
    // donc son coût est celui d'une requête, pas celui de recharger une semaine de tickets.
    topProducts(access.businessId, prev, employe),
    listSales(access.businessId, { seller: employe, ...range, limit: TICKET_FEED }),
    showHours
      ? listShifts(access.job, { identifier: employe, ...range, limit: SHIFT_LIMIT })
      : Promise.resolve([]),
    // Les heures EXACTES, agrégées en SQL: la liste ci-dessus est plafonnée, ce total ne l'est pas.
    showHours ? shiftTotals(access.job, range) : Promise.resolve([]),
    onDutyNow(access.job, SHIFT_STALE_MS),
    // `includeInactive`: un article retiré du catalogue a pu être vendu cette semaine, et sa carte
    // doit garder son dessin. Le libellé, lui, vient de la LIGNE de vente (copie datée), donc un
    // article renommé depuis reste affiché sous le nom qu'il portait au moment de la vente.
    listItems(access.businessId, { includeInactive: true }),
    gradesForJob(access.job),
  ]);

  // Le détail des articles n'est chargé QUE pour les tickets réellement dessinés. Voir TICKET_FEED.
  const lineSets = await Promise.all(sales.map((sale) => saleLines(access.businessId, sale.id)));

  const gradeLabels = new Map(ladder.map((g) => [g.grade, g.label]));
  const categoryLabels = new Map(access.categories.map((c) => [c.key, c.label]));
  const categoryTones = new Map(access.categories.map((c) => [c.key, c.tone]));
  const categoryIcons = new Map(access.categories.map((c) => [c.key, c.icon ?? null]));
  const artByItem = new Map(items.map((it) => [it.id, it.artKey]));

  const mine = sellerRows.find((r) => r.sellerIdentifier === employe);
  const totalCents = mine?.totalCents ?? 0;
  const commissionCents = mine?.commissionCents ?? 0;
  const marginCents = mine?.marginCents ?? 0;
  const salesCount = mine?.sales ?? 0;
  const teamTotalCents = sellerRows.reduce((acc, r) => acc + r.totalCents, 0);
  const prevTotalCents = prevRows.find((r) => r.sellerIdentifier === employe)?.totalCents ?? 0;
  const workedSeconds = hourRows.find((r) => r.identifier === employe)?.seconds ?? 0;

  /**
   * CE QU'IL VEND LE PLUS.
   *
   * ⚠ AGRÉGÉ EN SQL (`topProducts`), plus en parcourant les lignes des tickets chargés. L'ancienne
   * version faisait une requête `saleLines` par ticket de la période puis additionnait: correct
   * jusqu'à 500 tickets, faux en silence au-delà, et coûteux bien avant.
   *
   * ⚠ `item_id` EST NULLABLE (schema/citadel.ts): un article supprimé du catalogue laisse ses
   * lignes derrière lui avec un identifiant vide, et son libellé COPIÉ est la seule identité qui lui
   * reste. `topProducts` retombe alors sur `rayon + libellé`, jamais sur un regroupement de tous les
   * articles disparus. On reprend exactement la même clé ici pour que la comparaison avec la période
   * précédente porte sur les mêmes objets.
   */
  const keyOf = (p: { itemId: number | null; category: string; label: string }) =>
    p.itemId === null ? `l:${p.category}/${p.label}` : `i:${p.itemId}`;

  const products: TopProduct[] = productRows
    .map((p) => ({
      key: keyOf(p),
      label: p.label,
      categoryLabel: categoryLabels.get(p.category) ?? p.category,
      tone: categoryTones.get(p.category) ?? 1,
      artKey: p.itemId === null ? null : (artByItem.get(p.itemId) ?? null),
      categoryIcon: categoryIcons.get(p.category) ?? null,
      qty: p.qty,
      revenueCents: p.revenueCents,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents || b.qty - a.qty);
  const distinctProducts = products.length;
  const itemsSold = productRows.reduce((acc, p) => acc + p.qty, 0);

  /**
   * SON PROFIL PAR RAYON, cette période contre la précédente.
   *
   * ⚠ TOUS LES RAYONS DU COMMERCE SONT DES AXES, y compris ceux où il n'a rien vendu. C'est ce qui
   * rend deux fiches employé superposables: si chacune n'affichait que ses propres rayons, la
   * "forme" de deux vendeurs serait dessinée sur des toiles différentes et les comparer n'aurait
   * aucun sens. Un rayon à zéro est une information, pas une case à masquer.
   */
  const mixByKey = new Map<string, { label: string; cur: number; prev: number }>();
  for (const c of access.categories) mixByKey.set(c.key, { label: c.label, cur: 0, prev: 0 });
  const bump = (key: string, field: "cur" | "prev", cents: number) => {
    let entry = mixByKey.get(key);
    // Un rayon qui n'existe plus au catalogue mais qui a été vendu garde sa clé brute comme
    // libellé: elle est moins jolie qu'un intitulé, et infiniment plus honnête qu'une omission.
    if (!entry) {
      entry = { label: key, cur: 0, prev: 0 };
      mixByKey.set(key, entry);
    }
    entry[field] += cents;
  };
  for (const p of productRows) bump(p.category, "cur", p.revenueCents);
  for (const p of prevProductRows) bump(p.category, "prev", p.revenueCents);
  const mix: MixPoint[] = [...mixByKey.values()]
    .sort((a, b) => b.cur + b.prev - (a.cur + a.prev))
    .slice(0, MIX_MAX_AXES);
  const mixPrevTotalCents = prevProductRows.reduce((acc, p) => acc + p.revenueCents, 0);

  const tickets: TicketView[] = sales.map((sale, i) => {
    const lines = lineSets[i] ?? [];
    return {
      id: sale.id,
      publicRef: sale.publicRef,
      when: DATETIME_FMT.format(sale.declaredAt),
      detail: lines.length
        ? lines.map((l) => `${l.qty} x ${l.label}`).join(", ")
        : "Sans détail enregistré",
      note: sale.note,
      totalCents: sale.totalCents,
      commissionCents: sale.commissionCents,
      marginCents: sale.marginCents,
      backdated: sale.backdated,
      // ⚠ LA MÊME MISE EN FORME QUE LE JOURNAL DE L'EMPLOYÉ (`clientRecordView`). Le gérant et
      // l'employé doivent lire exactement la même fiche du même ticket: deux formulations écrites
      // séparément finiraient par diverger, et une divergence sur ce document-là est précisément
      // ce qui déclenche une accusation injuste.
      client: clientRecordView(sale.client),
    };
  });

  const shiftViews: ShiftView[] = shifts.map((sh) => ({
    id: sh.id,
    day: fmtDay(sh.startedAt),
    range: sh.endedAt
      ? `${TIME_FMT.format(sh.startedAt)} à ${TIME_FMT.format(sh.endedAt)}`
      : `Depuis ${TIME_FMT.format(sh.startedAt)}`,
    seconds: sh.seconds,
    why: sh.endedAt
      ? (ENDED_REASON_LABEL[sh.endedReason ?? ""] ?? sh.endedReason ?? "Motif inconnu")
      : "Service en cours",
    open: sh.endedAt === null,
  }));

  /**
   * SON RYTHME, jour par jour, ET CELUI DU COMMERCE, dans la même liste.
   *
   * ⚠ Rangé par CLÉ (`YYYY-MM-DD`), pas par comparaison d'instants: la somme vient de
   * `DATE(declared_at)` en SQL, donc ranger par cette même chaîne rend le découpage identique des
   * deux côtés par construction, y compris les deux nuits par an où l'heure d'été fait des journées
   * de 23 et de 25 heures.
   */
  const days = dayList(range.from, dayCount(range), period !== "prev");
  const dayIndex = new Map(days.map((d, i) => [d.key, i]));
  let unmatchedDays = 0;
  for (const cell of perDay) {
    const idx = dayIndex.get(cell.day);
    // ⚠ Signalé et non avalé: même raison que sur ../page.tsx, où le raisonnement complet est écrit.
    if (idx === undefined) {
      unmatchedDays++;
      continue;
    }
    days[idx]!.team += cell.totalCents;
    if (cell.sellerIdentifier === employe) days[idx]!.mine += cell.totalCents;
  }
  if (unmatchedDays > 0) {
    console.warn(
      `[employe] ${unmatchedDays} agrégat(s) journalier(s) hors des colonnes de la période`,
      { businessId: access.businessId, period, sample: perDay[0]?.day, colonnes: days[0]?.key },
    );
  }

  /**
   * SES HEURES PAR JOUR.
   *
   * ⚠ UN SERVICE EST RANGÉ AU JOUR OÙ IL A COMMENCÉ, donc une soirée qui finit à 2h du matin compte
   * entière dans la veille. C'est la lecture qu'attend un gérant qui pense en "soirées", et la seule
   * qui n'exige pas de découper une ligne de pointage en deux morceaux dont aucun n'existe en base.
   *
   * ⚠ Construit sur `listShifts`, donc plafonné à SHIFT_LIMIT services. Le TOTAL affiché en figure,
   * lui, vient de `shiftTotals` et reste exact: c'est la répartition qui pourrait manquer une
   * soirée très ancienne, pas la somme. Deux cents services sur trente jours n'arrivent pas.
   */
  const hours: HourPoint[] = days.map((d) => ({
    label: d.label,
    full: d.full,
    today: d.today,
    seconds: 0,
    cents: d.mine,
  }));
  for (const sh of shifts) {
    const idx = dayIndex.get(dayKey(sh.startedAt));
    if (idx === undefined) continue;
    hours[idx]!.seconds += sh.seconds;
  }

  const dutyRow = duty.find((d) => d.identifier === employe) ?? null;

  /**
   * LE GRADE: celui de l'ANNUAIRE quand la personne y figure, sinon l'instantané des pointages.
   *
   * `lifeinvader_business_shifts.grade` est copié à la prise de service, donc il dit ce que la personne
   * était ce jour-là, pas ce qu'elle est. C'était la seule source dont disposait ce portail; ce
   * n'est plus vrai, et le grade courant l'emporte pour quiconque tient encore le métier. Il ne
   * reste l'instantané que pour un ancien employé (un service ouvert est forcément le plus récent,
   * donc `duty` gagne sur la sonde d'appartenance).
   *
   * ⚠ Sans instantané non plus, on n'écrit AUCUN grade: `0` est un vrai rang (Recrue), pas une
   * valeur "inconnu".
   */
  const gradeNumber = member ? member.grade : (dutyRow?.grade ?? anyShift[0]?.grade ?? null);
  const gradeLabel = member
    ? member.gradeLabel
    : gradeNumber === null
      ? null
      : (gradeLabels.get(gradeNumber) ?? `Grade ${gradeNumber}`);

  // Le nom de l'annuaire d'abord: `sellerName` et le `name` d'un pointage sont des copies datées,
  // donc un employé renommé en jeu s'afficherait sous son ancien nom. Pour un ancien employé, cette
  // copie datée est au contraire la seule identité qui reste.
  const name = member?.name ?? anySale[0]?.sellerName ?? anyShift[0]?.name ?? "Employé";

  return (
    <EmployeView
      slug={access.slug}
      identifier={employe}
      name={name}
      gradeLabel={gradeLabel}
      // Absent de l'effectif du jour: la fiche reste consultable et ses chiffres restent exacts,
      // mais la page le dit une fois, en retrait. Même règle que le relevé d'équipe.
      former={member === null}
      period={period}
      canRead={true}
      deniedReason={null}
      showHours={showHours}
      showCommission={showCommission}
      onDutySeconds={dutyRow ? dutyRow.seconds : null}
      showMargin={showMargin}
      totalCents={totalCents}
      commissionCents={commissionCents}
      marginCents={marginCents}
      prevTotalCents={prevTotalCents}
      salesCount={salesCount}
      teamTotalCents={teamTotalCents}
      teamHeadcount={sellerRows.length}
      workedSeconds={workedSeconds}
      itemsSold={itemsSold}
      distinctProducts={distinctProducts}
      products={products.slice(0, TOP_PRODUCTS)}
      mix={mix}
      mixPrevTotalCents={mixPrevTotalCents}
      tickets={tickets}
      ticketsTotal={salesCount}
      shifts={shiftViews}
      hours={hours}
      days={days}
      shiftsTruncated={shifts.length >= SHIFT_LIMIT}
    />
  );
}
