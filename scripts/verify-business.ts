/**
 * verify-business - the two things about LifeInvader Entreprises that nothing else can prove.
 *
 * PART 1, the capability model, pure. `tsc` type-checks the SHAPE of CAP_TIER but not its
 * COMPLETENESS against anything: add a capability to CAP, forget it in CAP_TIER, and
 * `TIER_RANK[undefined]` yields NaN, `NaN >= n` is false, and the capability silently never works
 * for anyone including the boss. That is a fail-CLOSED bug, which is the good direction and exactly
 * why nobody notices for weeks. Same for a capability missing from CAPABILITY_CATALOG: the boss
 * loop builds its set from the catalog, so an uncatalogued capability is one the boss does not hold
 * either, and the Réglages page cannot offer it. Both are invisible at compile time.
 *
 * PART 2, the queries, against the REAL database. Same reason as verify-factions: the citadel_*
 * tables are utf8mb4_unicode_ci here while the ESX side is mixed, and MariaDB throws ERROR 1267 on a
 * mixed column comparison at RUNTIME while both sides type as `string`. Executing is the only proof.
 *
 *   npm run verify:business
 */
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  citadelBusinesses,
  citadelBusinessItems,
  citadelBusinessSaleLines,
  citadelBusinessSales,
  citadelBusinessShifts,
} from "@/lib/db/schema/citadel";
import {
  CAP,
  CAP_TIER,
  CAPABILITY_CATALOG,
  FALLBACK_CAPS,
  type Capability,
} from "@/lib/business/capabilities";
import { businessCan, usableCapabilities, type BusinessAccess, type BusinessTier } from "@/lib/business/access";
import { BUSINESS_MODULES, moduleOfCapability, resolveModules } from "@/lib/business/modules";
import {
  declareFreeSale,
  declareSale,
  listSales,
  saleLines,
  sellerTotals,
} from "@/lib/business/sales";
import { insertedId } from "@/lib/db/insertId";
import { jobGrades } from "@/lib/db/schema/game";
import { sql } from "drizzle-orm";
import {
  createItem,
  getCommissionPolicy,
  listItems,
  setCategories,
  setCommissionPolicy,
  setGrants,
  setLineCeiling,
  setModuleOverrides,
  updateItem,
} from "@/lib/business/catalogue";
import {
  percentToBps,
  rateFor,
  rateForGrade,
  resolveCommission,
  sanitizeCommission,
  unitCommissionCents,
  vehicleUnitCommissionCents,
  type CommissionPolicy,
} from "@/lib/business/commission";
import { correctShift, listShifts, onDutyNow, shiftTotals } from "@/lib/business/shifts";
import {
  BUSINESS_TEMPLATES,
  clientRecordRequired,
  templateBillsCustoms,
  templateCaisseDefault,
  templateClientRecord,
  templateCommission,
  templateGrid,
  templateSellsVehicles,
  VEHICLE_CATEGORY_KEY,
} from "@/lib/business/templates";
import {
  checkClientRecord,
  clientRecordView,
  CLIENT_RECORD_BOUNDS_FALLBACK,
  normalizeBirthdate,
  normalizePersonName,
  normalizePhone,
  normalizePlate,
  type ClientRecordBounds,
} from "@/lib/business/clientRecord";
import { clientRecordBounds } from "@/lib/business/clientRecordRules";
import {
  vehicleForJob,
  vehicleMarginCents,
  vehiclePriceCents,
  vehiclesForJob,
  fleetModelCount,
} from "@/lib/business/fleet";
import { ART_KEYS, CATEGORY_ICONS, PRODUCT_ART, visualFor } from "@/lib/business/art";
import { artCoverage, ITEM_ART, suggestArtKey } from "@/lib/business/itemArt";

/** LOWER(col) = 'x'. Evite toute question de collation sur une comparaison de casse. */
const eqLower = (col: unknown, v: string) => sql`LOWER(${col}) = ${v}`;

let failures = 0;
const ok = (label: string, detail = "") => console.log(`  ok   ${label}${detail ? ` - ${detail}` : ""}`);
const bad = (label: string, detail: string) => {
  failures++;
  console.error(`  FAIL ${label} - ${detail}`);
};
const assert = (cond: boolean, label: string, detail: string) =>
  cond ? ok(label) : bad(label, detail);

/** Un accès synthétique, pour interroger la porte sans base ni serveur de jeu. */
function fakeAccess(opts: {
  tier: BusinessTier;
  isBoss?: boolean;
  caps?: Iterable<string>;
  modules?: Record<string, boolean>;
  /** Accès réseau: dispense de la règle de présence, jamais du module ni du grade. */
  networkAdmin?: boolean;
}): BusinessAccess {
  return {
    businessId: 1,
    job: "vigneron",
    slug: "bar-du-vigneron",
    name: "Bar du Vigneron",
    template: "bar",
    moduleOverrides: {},
    modules: resolveModules(null, opts.modules),
    palette: { dark: {}, light: {} },
    categories: [],
    // Le mode historique: la part est un montant fixe par article. Les contrôles de ce script
    // portent sur la PORTE (`businessCan`), pas sur la paie, donc le taux n'a rien à y faire.
    commission: { mode: "montant", bps: 0, vehicleBps: 0 },
    // Aucune caisse a saisie libre par defaut: `null` est ce que porte tout commerce ordinaire,
    // et c'est ce qui doit faire refuser `declareFreeSale` si quelqu'un l'appelle par erreur.
    lineMaxCents: null,
    identifier: "deadbeef",
    employeeName: "Test Perso",
    grade: 1,
    gradeName: "Barman",
    isBoss: Boolean(opts.isBoss),
    capabilities: new Set(
      opts.isBoss ? CAPABILITY_CATALOG.map((c) => c.code) : (opts.caps ?? []),
    ),
    tier: opts.tier,
    onDuty: opts.tier === "service",
    shiftStartedAt: opts.tier === "service" ? new Date() : null,
    networkAdmin: Boolean(opts.networkAdmin),
  };
}

function modelChecks() {
  console.log("\nModèle de capacités (pur)");

  const codes = Object.values(CAP) as Capability[];
  const catalog = new Set(CAPABILITY_CATALOG.map((c) => c.code));

  for (const c of codes) {
    assert(catalog.has(c), `catalogue contient ${c}`, "absent de CAPABILITY_CATALOG: ni le patron ni la page Réglages ne l'auront");
    assert(
      CAP_TIER[c] !== undefined,
      `palier défini pour ${c}`,
      "absent de CAP_TIER: la capacité ne fonctionnera pour personne, silencieusement",
    );
  }
  assert(
    catalog.size === codes.length,
    "catalogue sans doublon ni orphelin",
    `${catalog.size} entrées de catalogue pour ${codes.length} capacités`,
  );

  // Le repli jour-un ne doit jamais ouvrir quelque chose de sensible: c'est un défaut permissif,
  // acceptable pour un geste routinier, jamais pour l'argent ou la vie privée des collègues.
  for (const entry of CAPABILITY_CATALOG) {
    if (entry.sensitive) {
      assert(
        !FALLBACK_CAPS.has(entry.code),
        `repli exclut ${entry.code}`,
        "capacité sensible offerte par défaut à tout employé d'un commerce non configuré",
      );
    }
  }

  // Tout ce qui ÉCRIT exige d'être pointé. Un droit d'écriture utilisable hors service laisserait
  // quelqu'un déclarer des ventes depuis son lit, ce qui vide le pointage de son sens.
  const writes: Capability[] = [CAP.SALE_DECLARE, CAP.SHIFT_EDIT, CAP.CATALOGUE_WRITE, CAP.SETTINGS_WRITE];
  for (const w of writes) {
    assert(CAP_TIER[w] === "service", `écriture ${w} exige le service`, `palier = ${CAP_TIER[w]}`);
  }
}

function artChecks() {
  console.log("\nVisuels produits");

  /**
   * ⚠ UNE CLE D'ICONE INVALIDE NE LEVE RIEN: elle retombe sur `box`. Le portail continue donc de
   * fonctionner pendant que CHAQUE rayon de CHAQUE commerce affiche la meme boite grise, et on
   * conclut que le portail est comme ca. C'est exactement ce qui est arrive: les modeles ont ete
   * ecrits avec des noms d'icones Lucide ("Beer", "CupSoda"), qui ressemblent assez aux cles de
   * CATEGORY_ICONS pour tromper la relecture et n'en sont aucune.
   */
  for (const t of BUSINESS_TEMPLATES) {
    for (const c of t.categories) {
      if (!c.icon) continue;
      assert(
        CATEGORY_ICONS[c.icon] !== undefined,
        `modele ${t.name}: icone connue pour le rayon ${c.key}`,
        `"${c.icon}" n'est pas une cle de CATEGORY_ICONS, le rayon s'afficherait avec la boite grise`,
      );
    }
  }

  /**
   * ⚠ L'ICONE D'UNE GRILLE DE CAISSE EST LE MEME PIEGE QUE CELLE D'UN RAYON, en pire: les vingt
   * cases la portent, donc une cle inconnue ne fait pas UN rayon gris, elle fait VINGT boites grises
   * identiques et on conclut que la caisse est comme ca. Rien ne leve, rien ne s'affiche en rouge.
   */
  for (const t of BUSINESS_TEMPLATES) {
    if (!t.grid) continue;
    /**
     * ⚠ `art` ET `icon` SONT DEUX FAMILLES, et se tromper de famille ne casse rien de visible:
     * `visualFor` retombe simplement sur le repli, donc les cases affichent un trait fin gris a la
     * place d'une vignette produit et on croit que la caisse est comme ca.
     */
    assert(
      PRODUCT_ART[t.grid.art] !== undefined,
      `modele ${t.name}: vignette connue pour la grille de caisse`,
      `"${t.grid.art}" n'est pas une cle de PRODUCT_ART, les ${t.grid.slots} cases retomberaient sur l'icone de rayon`,
    );
    assert(
      CATEGORY_ICONS[t.grid.icon] !== undefined,
      `modele ${t.name}: icone de repli connue pour la grille de caisse`,
      `"${t.grid.icon}" n'est pas une cle de CATEGORY_ICONS, le repli serait la boite grise`,
    );
    // Le repli n'est un repli que s'il ne sert jamais: si `visualFor` rend une ICONE, la caisse
    // dessine des traits fins a 36px la ou le proprietaire a demande une vignette pleine.
    assert(
      visualFor(t.grid.art, t.grid.icon).kind === "art",
      `modele ${t.name}: la grille rend bien une vignette pleine`,
      "visualFor retombe sur l'icone de rayon",
    );
  }

  // Le repli doit toujours produire quelque chose: une carte sans visuel est une carte a moitie
  // dessinee, et une grille entiere parait cassee a cause d'un champ vide en base.
  const none = visualFor(null, null);
  assert(none.svg.length > 0 && none.kind === "icon", "repli ultime non vide", JSON.stringify(none));
  const bogus = visualFor("nexistepas", "nexistepas");
  assert(bogus.svg.length > 0, "cle inconnue retombe sur le repli", "une cle inventee a produit un trou");
  const real = visualFor(ART_KEYS[0], null);
  assert(real.kind === "art", "une cle d'illustration connue rend une illustration", JSON.stringify(real.kind));

  // Les deux familles ont des formats differents et ne sont pas interchangeables: une illustration
  // posee dans le repli s'afficherait a 36px teintee, une icone posee en illustration a 72px.
  for (const [k, v] of Object.entries(PRODUCT_ART)) {
    assert(v.includes('viewBox="0 0 32 32"'), `art ${k} en viewBox 32`, "format d'illustration inattendu");
  }
  for (const [k, v] of Object.entries(CATEGORY_ICONS)) {
    assert(
      v.includes('viewBox="0 0 24 24"') && v.includes("currentColor"),
      `icone ${k} en viewBox 24 et currentColor`,
      "une icone qui ne suit pas currentColor ne prendra pas la couleur du rayon",
    );
  }

  /**
   * L'ALIGNEMENT AVEC LE CATALOGUE DU JEU (`itemArt.ts`).
   *
   * ⚠ UNE CLE MORTE CITEE DANS `ITEM_ART` NE LEVE RIEN. `visualFor` retombe sur l'icone du rayon,
   * donc renommer ou supprimer un dessin dans `art.ts` sans toucher la table laisse le portail
   * fonctionner pendant que le produit reel perd son illustration. C'est la meme classe de panne
   * silencieuse que les icones de rayon plus haut, et elle se detecte de la meme facon: ici.
   */
  for (const [item, art] of Object.entries(ITEM_ART)) {
    assert(
      PRODUCT_ART[art] !== undefined,
      `article ${item}: dessin ${art} present`,
      `"${art}" n'existe pas dans PRODUCT_ART, l'article afficherait l'icone de son rayon`,
    );
  }

  // Le selecteur doit savoir pre-choisir un dessin a partir d'un vrai nom d'article, et se taire
  // quand il ne sait pas. Une suggestion inventee est pire qu'une case vide: personne ne la corrige.
  assert(suggestArtKey("atomburger") === "burger", "suggestion sur un nom d'article exact", "atomburger n'a pas rendu burger");
  assert(suggestArtKey("inconnu_xyz") === null, "aucune suggestion quand on ne sait pas", "une cle a ete inventee pour un article inconnu");
  assert(suggestArtKey(null, "Verre de rouge") === "wineRed", "suggestion sur le libelle libre", "le repli par libelle n'a pas reconnu un verre de vin");
  assert(suggestArtKey(null, "Verre de vin chaud") === "mulledWine", "le libelle le plus specifique gagne", "vin chaud est tombe sur le verre de vin ordinaire");

  /**
   * LA COUVERTURE. Combien d'articles de bouche reellement vendables sur ce serveur ont un dessin.
   *
   * ⚠ CE N'EST PAS UN TEST QUI PASSE OU ECHOUE, C'EST UN CHIFFRE A LIRE. Un article ajoute au jeu
   * sans dessin fait reculer la ligne sans casser le build, ce qui est voulu: bloquer la CI sur un
   * dessin manquant pousserait a mapper n'importe quoi pour repasser au vert, et c'est precisement
   * comme ca qu'une bibliotheque se remet a mentir. La regression doit se VOIR, pas bloquer.
   */
  const cov = artCoverage();
  const pct = cov.total === 0 ? 0 : Math.round((cov.covered / cov.total) * 100);
  console.log(`  COUVERTURE  ${cov.covered}/${cov.total} articles de bouche du jeu ont un dessin (${pct}%)`);
  if (cov.missing.length > 0) {
    console.log(`  sans dessin: ${cov.missing.join(", ")}`);
  }
}

function gateChecks() {
  console.log("\nLa porte (businessCan)");

  // Le patron détient tout, mais le palier s'applique quand même.
  const bossOffline = fakeAccess({ tier: "session", isBoss: true });
  assert(!businessCan(bossOffline, CAP.TEAM_READ), "patron hors ligne ne lit pas l'équipe", "team.read passe au palier session");
  assert(!businessCan(bossOffline, CAP.CATALOGUE_WRITE), "patron hors ligne n'écrit pas", "une écriture est passée hors service");
  assert(businessCan(bossOffline, CAP.SALE_READ_SELF), "patron hors ligne lit ses ventes", "sale.read.self bloqué au palier session");

  const bossOnDuty = fakeAccess({ tier: "service", isBoss: true });
  for (const entry of CAPABILITY_CATALOG) {
    assert(
      businessCan(bossOnDuty, entry.code),
      `patron en service détient ${entry.code}`,
      "le patron doit tout détenir, sans exception et sans ligne en base",
    );
  }

  // Un employé au repli: encaisse, lit ses propres chiffres, et rien de plus.
  const rookie = fakeAccess({ tier: "service", caps: FALLBACK_CAPS });
  assert(businessCan(rookie, CAP.SALE_DECLARE), "employé au repli encaisse", "sale.declare refusé");
  assert(!businessCan(rookie, CAP.TEAM_READ), "employé au repli ne voit pas l'équipe", "fuite des chiffres des collègues");
  assert(!businessCan(rookie, CAP.CATALOGUE_WRITE), "employé au repli ne change pas les prix", "écriture catalogue accordée par défaut");

  // Un grade explicitement vidé n'a PAS le repli: c'est une décision, pas une absence.
  const stripped = fakeAccess({ tier: "service", caps: [] });
  assert(
    !businessCan(stripped, CAP.SALE_DECLARE),
    "grade vidé n'encaisse pas",
    "le repli s'est appliqué à un grade délibérément vidé, annulant la décision du patron",
  );

  // Un droit accordé ne franchit pas un palier non atteint.
  const graded = fakeAccess({ tier: "ingame", caps: [CAP.TEAM_READ, CAP.CATALOGUE_WRITE] });
  assert(businessCan(graded, CAP.TEAM_READ), "gérant en jeu lit l'équipe", "team.read refusé au palier ingame");
  assert(!businessCan(graded, CAP.CATALOGUE_WRITE), "gérant en jeu mais hors service n'écrit pas", "écriture passée sans pointage");

  // Un module éteint ferme la porte, y compris au patron: la fonctionnalité n'existe pas pour ce
  // commerce, ce n'est pas un refus de droit. Sans ça le reglage ne serait qu'un onglet cache.
  const noPointage = fakeAccess({ tier: "service", isBoss: true, modules: { pointage: false } });
  assert(!businessCan(noPointage, CAP.SHIFT_EDIT), "module éteint ferme la correction d'heures", "shift.edit joignable malgré le module pointage éteint");
  assert(!businessCan(noPointage, CAP.SHIFT_READ), "module éteint ferme la lecture des pointages", "shift.read passe malgré le module éteint");
  assert(businessCan(noPointage, CAP.SALE_DECLARE), "les autres modules ne sont pas affectés", "sale.declare cassé par l'extinction de pointage");

  // ⚠ ANTI-ENFERMEMENT. Si settings.write dependait d'un module, eteindre ce module rendrait les
  // reglages inaccessibles, donc impossible a rallumer. Le commerce serait mort sans recours.
  assert(
    moduleOfCapability(CAP.SETTINGS_WRITE) === null,
    "settings.write n'appartient à aucun module",
    "les réglages dépendent d'un module: l'éteindre enfermerait le commerce dehors sans recours",
  );

  /* ── Accès réseau (console MIRAGE) ────────────────────────────────────────────────────────────
   * Ce que le drapeau lève, et surtout ce qu'il NE lève PAS. Un drapeau qui dispense de tout serait
   * une porte dérobée; ces trois assertions sont ce qui distingue les deux.
   */
  const netAdmin = fakeAccess({ tier: "session", isBoss: false, caps: CAPABILITY_CATALOG.map((c) => c.code), networkAdmin: true });
  assert(
    businessCan(netAdmin, CAP.CATALOGUE_WRITE),
    "accès réseau écrit sans être pointé",
    "la dispense de palier ne s'applique pas: la console ne peut rien réparer",
  );
  assert(
    !businessCan(
      fakeAccess({ tier: "session", caps: CAPABILITY_CATALOG.map((c) => c.code), modules: { pointage: false }, networkAdmin: true }),
      CAP.SHIFT_EDIT,
    ),
    "accès réseau ne force PAS un module éteint",
    "networkAdmin franchit un module éteint: la fonctionnalité n'existe pas pour ce commerce, même pour la console",
  );
  assert(
    !businessCan(fakeAccess({ tier: "service", caps: [], networkAdmin: true }), CAP.SALE_DECLARE),
    "accès réseau sans la capacité reste refusé",
    "networkAdmin a suffi à lui seul: le drapeau doit lever le PALIER, pas le jeu de capacités",
  );
  assert(
    !fakeAccess({ tier: "session", networkAdmin: true }).onDuty,
    "accès réseau n'invente pas un service",
    "onDuty vrai pour un administrateur qui n'a pris aucun service: la barre afficherait une présence fausse",
  );
  const allOff = fakeAccess({
    tier: "service",
    isBoss: true,
    modules: Object.fromEntries(BUSINESS_MODULES.map((m) => [m.key, false])),
  });
  assert(
    businessCan(allOff, CAP.SETTINGS_WRITE),
    "réglages accessibles tous modules éteints",
    "aucun chemin pour rallumer quoi que ce soit",
  );
  for (const m of BUSINESS_MODULES) {
    if (m.core) {
      assert(
        allOff.modules[m.key] === true,
        `module essentiel ${m.key} résiste à l'extinction`,
        "un module essentiel a pu être éteint par un écart",
      );
    }
    if (m.soon) {
      assert(
        resolveModules({ [m.key]: true }, { [m.key]: true })[m.key] === false,
        `module à venir ${m.key} reste éteint`,
        "un module non construit a pu être allumé depuis les données",
      );
    }
  }

  const usable = usableCapabilities(graded);
  assert(
    usable.length === 1 && usable[0] === CAP.TEAM_READ,
    "usableCapabilities filtre par palier",
    `rendu: ${usable.join(", ") || "(vide)"}`,
  );
}

async function step<T>(label: string, run: () => Promise<T>, fmt: (v: T) => string) {
  try {
    ok(label, fmt(await run()));
  } catch (e) {
    bad(label, e instanceof Error ? e.message : String(e));
  }
}

async function queryChecks() {
  console.log("\nRequêtes réelles");

  await step("businesses", () => db.select().from(citadelBusinesses).limit(5), (r) => `${r.length} commerce(s)`);
  await step("items", () => db.select().from(citadelBusinessItems).limit(5), (r) => `${r.length} article(s)`);
  await step("sales", () => db.select().from(citadelBusinessSales).limit(5), (r) => `${r.length} vente(s)`);
  await step("sale_lines", () => db.select().from(citadelBusinessSaleLines).limit(5), (r) => `${r.length} ligne(s)`);

  // La requête exacte du résolveur: pointage ouvert ET frais. C'est elle qui décide du palier
  // service, donc de toute écriture; si elle explose, le portail est en lecture seule sans le dire.
  await step(
    "pointages ouverts et frais (requête du résolveur)",
    () =>
      db
        .select()
        .from(citadelBusinessShifts)
        .where(
          and(
            isNull(citadelBusinessShifts.endedAt),
            gt(citadelBusinessShifts.heartbeatAt, new Date(Date.now() - 5 * 60_000)),
          ),
        )
        .limit(5),
    (r) => `${r.length} en service`,
  );

  // ⚠ Les datetimes doivent être des Date à l'EXÉCUTION, pas des chaînes. `sql<Date>` est une
  // ASSERTION sans conversion, et une chaîne meurt au premier .getTime() côté page.
  const shifts = await db.select().from(citadelBusinessShifts).limit(1);
  if (shifts[0]) {
    assert(
      shifts[0].startedAt instanceof Date,
      "shifts.started_at hydrate en Date",
      `type reçu: ${typeof shifts[0].startedAt}`,
    );
  } else {
    console.log("  skip shifts.started_at - aucune ligne encore");
  }

  // Le repli jour-un est-il actif quelque part? Purement informatif, mais c'est la question que
  // pose le patron quand il dit "pourquoi mes employés ne voient rien".
  const bizs = await db
    .select({ id: citadelBusinesses.id, name: citadelBusinesses.name, grants: citadelBusinesses.grants })
    .from(citadelBusinesses);
  for (const b of bizs) {
    console.log(`  info ${b.name} - ${b.grants ? "droits configurés" : "aucun droit configuré (repli jour-un actif)"}`);
  }
}

/**
 * LE CHEMIN DE VENTE, exercé pour de vrai contre la base.
 *
 * Monte deux commerces jetables, déclare, et nettoie. Les quatre protections de `declareSale` sont
 * toutes du genre qui se lit correct et se comporte mal: un `business_id` oublié dans un WHERE, une
 * transaction qui n'en est pas une, une clé d'idempotence qu'aucun index n'appuie. Aucune ne se voit
 * à la relecture, aucune ne se voit au typecheck. Il faut les faire échouer exprès.
 */
async function salePathChecks() {
  console.log("\nChemin de vente (base réelle, données jetables)");
  const A = "__verify_biz_a";
  const B = "__verify_biz_b";
  const seller = "__verify_seller_hex";

  const cleanup = async () => {
    const rows = await db
      .select({ id: citadelBusinesses.id })
      .from(citadelBusinesses)
      .where(inArray(citadelBusinesses.job, [A, B]));
    for (const r of rows) {
      const sales = await db
        .select({ id: citadelBusinessSales.id })
        .from(citadelBusinessSales)
        .where(eq(citadelBusinessSales.businessId, r.id));
      for (const s of sales) {
        await db.delete(citadelBusinessSaleLines).where(eq(citadelBusinessSaleLines.saleId, s.id));
      }
      await db.delete(citadelBusinessSales).where(eq(citadelBusinessSales.businessId, r.id));
      await db.delete(citadelBusinessItems).where(eq(citadelBusinessItems.businessId, r.id));
    }
    await db.delete(citadelBusinesses).where(inArray(citadelBusinesses.job, [A, B]));
  };

  await cleanup(); // une exécution précédente interrompue ne doit pas faire échouer celle-ci
  try {
    const mk = async (job: string, name: string) => {
      const res = await db
        .insert(citadelBusinesses)
        .values({ job, slug: job.replace(/_/g, "-"), name, template: "commerce" });
      return insertedId(res);
    };
    const aId = await mk(A, "Vérif A");
    const bId = await mk(B, "Vérif B");

    const mkItem = async (businessId: number, label: string, price: number, comm: number) => {
      const res = await db
        .insert(citadelBusinessItems)
        .values({ businessId, label, category: "test", priceCents: price, commissionCents: comm });
      return insertedId(res);
    };
    const i1 = await mkItem(aId, "Article 1", 1250, 100); // 12,50 $ / part 1 $
    const i2 = await mkItem(aId, "Article 2", 400, 25);
    const foreign = await mkItem(bId, "Article du voisin", 999_999, 0);

    const access: BusinessAccess = {
      ...fakeAccess({ tier: "service" }),
      businessId: aId,
      identifier: seller,
    };

    // Prix serveur: 2 x 1250 + 3 x 400 = 3700; part 2 x 100 + 3 x 25 = 275.
    const r1 = await declareSale(access, {
      lines: [
        { itemId: i1, qty: 2 },
        { itemId: i2, qty: 3 },
      ],
      clientRef: "verif-1",
    });
    assert(r1.ok && r1.totalCents === 3700, "total calculé serveur", `reçu ${JSON.stringify(r1)}`);
    assert(r1.ok && r1.commissionCents === 275, "part employé calculée serveur", `reçu ${JSON.stringify(r1)}`);

    // Idempotence: le même geste renvoyé ne crée pas un second ticket.
    const r2 = await declareSale(access, {
      lines: [
        { itemId: i1, qty: 2 },
        { itemId: i2, qty: 3 },
      ],
      clientRef: "verif-1",
    });
    assert(r2.ok && r2.duplicate === true, "rejeu détecté comme doublon", `reçu ${JSON.stringify(r2)}`);
    const count = await db
      .select({ id: citadelBusinessSales.id })
      .from(citadelBusinessSales)
      .where(eq(citadelBusinessSales.businessId, aId));
    assert(count.length === 1, "un seul ticket après rejeu", `${count.length} tickets écrits`);

    // Transaction: les lignes existent, et elles ont copié prix et libellé.
    const lines = await saleLines(aId, count[0]!.id);
    assert(lines.length === 2, "les lignes du ticket sont écrites", `${lines.length} ligne(s)`);
    assert(
      lines.every((l) => l.unitPriceCents > 0 && l.label.length > 0),
      "les lignes copient prix et libellé",
      "une ligne a un prix ou un libellé vide",
    );

    // ⚠ Cloisonnement: un article d'un AUTRE commerce doit être refusé, pas facturé à 9 999,99 $.
    const rForeign = await declareSale(access, { lines: [{ itemId: foreign, qty: 1 }], clientRef: "verif-2" });
    assert(!rForeign.ok && rForeign.error === "unknown_item", "article d'un autre commerce refusé", `reçu ${JSON.stringify(rForeign)}`);

    const rQty = await declareSale(access, { lines: [{ itemId: i1, qty: 0 }], clientRef: "verif-3" });
    assert(!rQty.ok && rQty.error === "bad_qty", "quantité nulle refusée", `reçu ${JSON.stringify(rQty)}`);
    const rHuge = await declareSale(access, { lines: [{ itemId: i1, qty: 100_000 }], clientRef: "verif-4" });
    assert(!rHuge.ok && rHuge.error === "bad_qty", "quantité aberrante refusée", `reçu ${JSON.stringify(rHuge)}`);
    /**
     * ⚠⚠ LE CONTOURNEMENT PAR ACCUMULATION, trouvé par l'audit de sécurité du 2026-08-08.
     *
     * Chaque ligne est plafonnée à 999, puis les lignes du MÊME article sont additionnées. Envoyer
     * 501 fois le même article à 999 passait donc tous les contrôles (chaque ligne sous le plafond,
     * un seul article distinct) et enregistrait 500 499 unités. `commission_cents` étant ce que
     * l'employeur verse en fin de semaine, c'était une fabrication de salaire en une requête, que
     * le plafond de cadence ne freine pas.
     *
     * Le test à une seule ligne juste au-dessus passait déjà avant le correctif: c'est PRÉCISÉMENT
     * pour ça qu'il faut celui-ci.
     */
    const rAccum = await declareSale(access, {
      lines: Array.from({ length: 501 }, () => ({ itemId: i1, qty: 999 })),
      clientRef: "verif-accum",
    });
    assert(
      !rAccum.ok && (rAccum.error === "bad_qty" || rAccum.error === "too_many_lines"),
      "quantité cumulée par répétition refusée",
      `500 499 unités enregistrées sur un ticket: ${JSON.stringify(rAccum)}`,
    );
    const rFlood = await declareSale(access, {
      lines: Array.from({ length: 5000 }, () => ({ itemId: i1, qty: 1 })),
      clientRef: "verif-flood",
    });
    assert(!rFlood.ok && rFlood.error === "too_many_lines", "tableau de lignes borné", JSON.stringify(rFlood));

    const rEmpty = await declareSale(access, { lines: [], clientRef: "verif-5" });
    assert(!rEmpty.ok && rEmpty.error === "empty", "ticket vide refusé", `reçu ${JSON.stringify(rEmpty)}`);

    // Module part employé éteint: la part ne s'accumule pas en silence.
    const noComm: BusinessAccess = { ...access, modules: { ...access.modules, commissions: false } };
    const rNc = await declareSale(noComm, { lines: [{ itemId: i1, qty: 1 }], clientRef: "verif-6" });
    assert(rNc.ok && rNc.commissionCents === 0, "module part éteint => part nulle", `reçu ${JSON.stringify(rNc)}`);

    // ⚠ SUM/COUNT reviennent en CHAÎNES via mysql2. Sans Number(), la page concatènerait.
    const totals = await sellerTotals(aId);
    assert(totals.length === 1, "un vendeur dans le classement", `${totals.length} vendeur(s)`);
    assert(
      typeof totals[0]!.totalCents === "number" && typeof totals[0]!.sales === "number",
      "les agrégats sont des nombres",
      `totalCents=${typeof totals[0]!.totalCents} sales=${typeof totals[0]!.sales}`,
    );
    assert(totals[0]!.totalCents === 3700 + 1250, "somme du classement exacte", `reçu ${totals[0]!.totalCents}`);

    const mine = await listSales(aId, { seller });
    assert(mine.length === 2, "listSales filtre par vendeur", `${mine.length} ligne(s)`);
    const other = await listSales(aId, { seller: "personne" });
    assert(other.length === 0, "listSales ne fuit pas d'un vendeur à l'autre", `${other.length} ligne(s)`);

    const luxuryCars = vehiclesForJob("luxury");
    /**
     * ⚠ ON PREND UNE VOITURE QUI A UNE MARGE, PAS LA PREMIERE DE LA LISTE (2026-08-27).
     *
     * La prime vehicule vaut un pourcentage de `prix client - prix concession`, donc un modele sans
     * `dealerPrice` dans vehicleList.lua rapporte zero. Tester avec un tel modele ferait passer
     * l'assertion de part en comparant 0 a 0: verte, et incapable de detecter que la formule est
     * fausse. C'est exactement la forme du bug qu'on vient de corriger, ou 100 % de marge par defaut
     * rendait le calcul insensible a la vraie donnee.
     *
     * Repli sur la premiere voiture si AUCUNE n'a de marge, avec une assertion qui le dit: ce n'est
     * pas un echec du code, c'est un catalogue de jeu a completer, et le script doit distinguer les
     * deux au lieu de tomber.
     */
    const car = luxuryCars.find((v) => vehicleMarginCents(v) > 0) ?? luxuryCars[0];
    assert(Boolean(car), "luxury a un catalogue FleetRoster pour le chemin de vente", "extract-fleet vide");
    assert(
      !car || vehicleMarginCents(car) > 0,
      "au moins une voiture luxury a un dealerPrice (sinon la part vehicule est intestable)",
      "aucun modele luxury ne porte dealerPrice: la part vehicule vaut 0 partout",
    );
    if (car) {
      const dealer: BusinessAccess = {
        ...fakeAccess({ tier: "service" }),
        businessId: aId,
        identifier: seller,
        job: "luxury",
        template: "concession",
        grade: 1,
        commission: {
          mode: "montant",
          bps: 0,
          vehicleBps: 1000,
        },
      };
      /**
       * LA FICHE CLIENT, exigee par le modele `concession` des qu'une voiture est au ticket.
       *
       * ⚠ AJOUTEE AUX CINQ APPELS CI-DESSOUS LE 2026-08-21, ET C'EST LE TEST QUI A TROUVE LE
       * CHANGEMENT DE COMPORTEMENT, pas une relecture: les cinq assertions vehicule sont passees de
       * vertes a `client_required` a la seconde ou le drapeau a ete pose sur le modele. C'est
       * exactement ce qu'on veut d'une contrainte de ce genre - qu'elle soit impossible a introduire
       * sans que quelque chose le dise.
       *
       * ⚠ LA PLAQUE EST VOLONTAIREMENT UNE QUI N'EXISTE PAS. `lookupSaleVehicle` va donc vraiment
       * interroger `owned_vehicles` et rendre `absent`, ce qui exerce la requete reelle (collation
       * du jeu comprise) ET prouve la propriete qui compte: une plaque introuvable N'EMPECHE PAS la
       * declaration. La refuser bloquerait une concession qui declare avant la livraison.
       */
      const FICHE = {
        firstname: "Jean",
        lastname: "Dupont",
        dob: "05/04/1988",
        phone: "5550134",
        plate: "ZZVERIF1",
      };

      const price = vehiclePriceCents(car);
      const expectShare = vehicleUnitCommissionCents(vehicleMarginCents(car), 1000);

      // La contrainte elle-meme, avant tout le reste: sans fiche, une voiture ne part pas.
      const rNoFiche = await declareSale(dealer, {
        lines: [],
        vehicles: [{ model: car.model, qty: 1 }],
        clientRef: "verif-car-nofiche",
      });
      assert(
        !rNoFiche.ok && rNoFiche.error === "client_required",
        "concession: une voiture sans fiche client est refusee",
        JSON.stringify(rNoFiche),
      );

      // Une fiche a moitie remplie est TOUJOURS une erreur, et elle nomme le champ fautif.
      const rBadFiche = await declareSale(dealer, {
        lines: [],
        vehicles: [{ model: car.model, qty: 1 }],
        client: { ...FICHE, dob: "1988-04-05" },
        clientRef: "verif-car-badfiche",
      });
      assert(
        !rBadFiche.ok && rBadFiche.error === "client_invalid" && rBadFiche.field === "dob",
        "concession: une fiche mal saisie nomme le champ fautif",
        JSON.stringify(rBadFiche),
      );

      // La fiche ne porte qu'UNE plaque: deux voitures sur un ticket produiraient un document faux.
      const rTwoCars = await declareSale(dealer, {
        lines: [],
        vehicles: [{ model: car.model, qty: 2 }],
        client: FICHE,
        clientRef: "verif-car-two",
      });
      assert(
        !rTwoCars.ok && rTwoCars.error === "too_many_vehicles",
        "concession: deux voitures sur un ticket sont refusees",
        JSON.stringify(rTwoCars),
      );

      const rCar = await declareSale(dealer, {
        lines: [],
        vehicles: [{ model: car.model, qty: 1 }],
        client: FICHE,
        clientRef: "verif-car-1",
      });
      assert(rCar.ok && rCar.totalCents === price, "prix vehicule lu serveur", JSON.stringify(rCar));
      // La plaque inconnue est enregistree et RAPPORTEE comme introuvable, jamais silencieuse.
      assert(
        rCar.ok && rCar.vehicle?.record === "absent",
        "une plaque introuvable est enregistree ET signalee a l'employe",
        JSON.stringify(rCar.ok ? rCar.vehicle : rCar),
      );
      // Et elle se relit telle quelle sur le ticket: normalisee, avec son tri-etat.
      const relu = (await listSales(aId, { seller })).find((x) => x.publicRef === (rCar.ok ? rCar.publicRef : ""));
      assert(
        relu?.client?.plate === "ZZVERIF1" &&
          relu?.client?.firstname === "Jean" &&
          relu?.client?.vehicle.record === "absent",
        "la fiche se relit depuis la base, tri-etat compris",
        JSON.stringify(relu?.client),
      );
      assert(rCar.ok && rCar.commissionCents === expectShare, "part vehicule = % du profit du grade", JSON.stringify(rCar));

      const rGhost = await declareSale(dealer, {
        lines: [],
        vehicles: [{ model: "zzzz_not_a_car", qty: 1 }],
        client: FICHE,
        clientRef: "verif-car-2",
      });
      assert(
        !rGhost.ok && rGhost.error === "unknown_vehicle",
        "modele inconnu refuse",
        JSON.stringify(rGhost),
      );

      const asBar: BusinessAccess = { ...dealer, template: "bar" };
      const rBar = await declareSale(asBar, {
        lines: [],
        vehicles: [{ model: car.model, qty: 1 }],
        clientRef: "verif-car-3",
      });
      assert(
        !rBar.ok && rBar.error === "unknown_vehicle",
        "un bar ne declare pas de vehicule",
        JSON.stringify(rBar),
      );

      const exclusive = luxuryCars.find((c) => !c.sellers.includes("cardealer"));
      if (exclusive) {
        const asPdm: BusinessAccess = { ...dealer, job: "cardealer" };
        const rSteal = await declareSale(asPdm, {
          lines: [],
          vehicles: [{ model: exclusive.model, qty: 1 }],
          client: FICHE,
          clientRef: "verif-car-4",
        });
        assert(
          !rSteal.ok && rSteal.error === "unknown_vehicle",
          "PDM ne vend pas une voiture Luxury exclusive",
          JSON.stringify(rSteal),
        );
      }

      const rMix = await declareSale(dealer, {
        lines: [{ itemId: i1, qty: 1 }],
        vehicles: [{ model: car.model, qty: 1 }],
        client: FICHE,
        clientRef: "verif-car-5",
      });
      assert(
        rMix.ok && rMix.totalCents === price + 1250,
        "ticket mixte article + vehicule",
        JSON.stringify(rMix),
      );
    }

    await catalogueChecks(aId, bId);
  } finally {
    await cleanup();
    ok("nettoyage des données de vérification");
  }
}

/**
 * CATALOGUE ET RÉGLAGES, sur les commerces jetables déjà montés.
 *
 * La propriété la plus importante prouvée ici: **le grade patron ne peut pas se voir retirer un
 * droit**. Le refuser par une erreur ne suffirait pas (quelqu'un finirait par l'ignorer); on écrit
 * la demande APRÈS avoir retiré le patron, donc la révocation n'a aucune représentation possible en
 * base. Un test est le seul moyen de savoir que le filtre est bien branché.
 */
async function catalogueChecks(aId: number, bId: number) {
  console.log("\nCatalogue et réglages");

  /**
   * ⚠ LES COLONNES JSON DOIVENT REVENIR EN OBJETS. MariaDB range le JSON en LONGTEXT sans le
   * signaler sur le fil, donc le `json()` de drizzle rend une CHAÎNE, pendant que `.$type<T>()` fait
   * croire à tsc que c'est un T. Le symptôme dur est `x.some is not a function`; le symptôme MOU est
   * pire: `grants["2"] ?? []` sur une chaîne rend `[]`, donc tout employé non patron perd
   * silencieusement toutes ses capacités dès qu'un patron configure quoi que ce soit. Corrigé par le
   * type `parsedJson` (lib/db/types.ts), et c'est CETTE assertion qui prouve qu'il est branché.
   */
  await db
    .update(citadelBusinesses)
    .set({ categories: [{ key: "test", label: "Test", tone: 1 }], grants: { "2": ["team.read"] } })
    .where(eq(citadelBusinesses.id, aId));
  const [hydrated] = await db
    .select({ categories: citadelBusinesses.categories, grants: citadelBusinesses.grants })
    .from(citadelBusinesses)
    .where(eq(citadelBusinesses.id, aId))
    .limit(1);
  assert(
    Array.isArray(hydrated?.categories),
    "colonne JSON `categories` revient en tableau",
    `typeof ${typeof hydrated?.categories} - le json() brut de drizzle rend une chaîne sur MariaDB`,
  );
  assert(
    Array.isArray(hydrated?.grants?.["2"]),
    "colonne JSON `grants` revient en objet",
    `typeof ${typeof hydrated?.grants} - tout employé non patron perdrait ses droits en silence`,
  );

  // ⚠ On EMPRUNTE un vrai métier en LECTURE SEULE pour son grade patron: `job_grades` appartient au
  // JEU, et un script de vérification n'y écrit rien, jamais. Sans un métier qui en possède un, le
  // filtre patron n'aurait rien à retirer et le test passerait sans rien prouver.
  const [realBoss] = await db
    .select({ job: jobGrades.jobName, grade: jobGrades.grade })
    .from(jobGrades)
    .where(eqLower(jobGrades.name, "boss"))
    .limit(1);
  if (!realBoss) {
    bad("grade patron trouvable", "aucun métier ne porte un grade nommé 'boss' en base");
    return;
  }

  const written = await setGrants(aId, realBoss.job, {
    [realBoss.grade]: [CAP.CATALOGUE_READ], // tentative de RETIRER des droits au patron
    2: [CAP.TEAM_READ, "capacite.inventee", CAP.TEAM_READ],
    "-1": [CAP.TEAM_READ],
  });
  assert(
    written.grants[String(realBoss.grade)] === undefined,
    "le grade patron est retiré de ce qu'on écrit",
    `le patron (grade ${realBoss.grade}) a été écrit en base: la révocation est devenue possible`,
  );
  assert(
    JSON.stringify(written.grants["2"]) === JSON.stringify([CAP.TEAM_READ]),
    "capacité inconnue écartée, doublon fusionné",
    `reçu ${JSON.stringify(written.grants["2"])}`,
  );
  assert(written.grants["-1"] === undefined, "grade négatif ignoré", "un grade impossible a été écrit");

  // `{}` doit être écrivable: "tout retiré" n'est pas "jamais configuré".
  const emptied = await setGrants(aId, realBoss.job, {});
  assert(
    emptied.grants && Object.keys(emptied.grants).length === 0,
    "on peut tout retirer (objet vide, pas null)",
    `reçu ${JSON.stringify(emptied.grants)}`,
  );

  // Modules: essentiels et à-venir résistent à l'écriture, pas seulement à la lecture.
  const mods = await setModuleOverrides(aId, { caisse: false, stock: true, equipe: false, inconnu: true });
  assert(mods.overrides.caisse === undefined, "module essentiel non éteignable à l'écriture", "caisse a pu être éteint");
  assert(mods.overrides.stock === undefined, "module à venir non allumable à l'écriture", "stock a pu être allumé");
  assert(mods.overrides.inconnu === undefined, "clé de module inconnue écartée", "une clé inventée a été stockée");
  assert(mods.overrides.equipe === false, "un module réel s'éteint bien", `reçu ${JSON.stringify(mods.overrides)}`);

  // Rayons: un rayon qui porte encore des articles ne disparaît pas.
  const okCats = await setCategories(aId, [{ key: "test", label: "Test", tone: 2 }]);
  assert(okCats.ok, "rayon en usage conservé acceptable", JSON.stringify(okCats));
  const dropUsed = await setCategories(aId, [{ key: "autre", label: "Autre", tone: 1 }]);
  assert(
    !dropUsed.ok && dropUsed.error === "in_use",
    "rayon encore utilisé non supprimable",
    `des articles seraient devenus invisibles: ${JSON.stringify(dropUsed)}`,
  );
  const badTone = await setCategories(aId, [{ key: "test", label: "Test", tone: 9 }]);
  assert(!badTone.ok && badTone.error === "bad_tone", "ton hors palette refusé", JSON.stringify(badTone));

  // Articles: rayon inconnu refusé, part supérieure au prix ACCEPTÉE (ce n'est pas une remise).
  const badCat = await createItem(aId, { label: "X", category: "nexistepas", priceCents: 100, commissionCents: 0 });
  assert(!badCat.ok && badCat.error === "unknown_category", "article dans un rayon inconnu refusé", JSON.stringify(badCat));
  const bigComm = await createItem(aId, { label: "Part généreuse", category: "test", priceCents: 100, commissionCents: 500 });
  assert(bigComm.ok, "part employé supérieure au prix acceptée", `la part a été traitée comme une remise: ${JSON.stringify(bigComm)}`);
  const negPrice = await createItem(aId, { label: "X", category: "test", priceCents: -1, commissionCents: 0 });
  assert(!negPrice.ok && negPrice.error === "bad_price", "prix négatif refusé", JSON.stringify(negPrice));

  // ⚠ Cloisonnement en ÉCRITURE: modifier un article du commerce voisin doit échouer.
  const [foreignItem] = await listItems(bId, { includeInactive: true });
  if (foreignItem) {
    const stolen = await updateItem(aId, foreignItem.id, {
      label: "Détourné",
      category: "test",
      priceCents: 1,
      commissionCents: 0,
    });
    assert(
      !stolen.ok && stolen.error === "not_found",
      "article d'un autre commerce non modifiable",
      "le cloisonnement en écriture ne tient pas",
    );
  }
}

/** Les pointages: la fenêtre, les totaux, et le refus de corriger un service en cours. */
async function shiftChecks() {
  console.log("\nPointages");
  const job = "__verify_shift_job";
  const who = "__verify_shift_hex";
  const cleanup = () => db.delete(citadelBusinessShifts).where(eq(citadelBusinessShifts.job, job));

  await cleanup();
  try {
    const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000);

    // Un service fermé de 2 h.
    await db.insert(citadelBusinessShifts).values({
      job, identifier: who, name: "Testeur", grade: 1,
      startedAt: t(180), endedAt: t(60), heartbeatAt: t(60), endedReason: "debauche",
    });
    // ⚠ Un service OUVERT dont le heartbeat s'est arrêté il y a 2 h: un serveur qui a planté.
    //   La durée retenue doit être 1 h (début -> dernier signe de vie), PAS 3 h (début -> maintenant).
    await db.insert(citadelBusinessShifts).values({
      job, identifier: who, name: "Testeur", grade: 1,
      startedAt: t(180), endedAt: null, heartbeatAt: t(120),
    });

    const rows = await listShifts(job);
    assert(rows.length === 2, "les pointages se lisent", `${rows.length} ligne(s)`);
    assert(
      rows.every((r) => typeof r.seconds === "number"),
      "les durées sont des nombres",
      "TIMESTAMPDIFF est revenu en chaîne, une addition les concatènerait",
    );
    const open = rows.find((r) => r.endedAt === null)!;
    assert(
      Math.abs(open.seconds - 3600) < 90,
      "service ouvert compté jusqu'au DERNIER HEARTBEAT",
      `${open.seconds}s au lieu de ~3600s: un plantage serveur créditerait des heures à toute l'équipe`,
    );

    const totals = await shiftTotals(job);
    assert(totals.length === 1, "un employé dans les totaux", `${totals.length}`);
    assert(Math.abs(totals[0]!.seconds - 3600 * 3) < 180, "total = 2 h + 1 h", `${totals[0]!.seconds}s`);
    assert(totals[0]!.shifts === 2, "deux services comptés", `${totals[0]!.shifts}`);

    const duty = await onDutyNow(job, 5 * 60_000);
    assert(duty.length === 0, "un heartbeat périmé n'est plus en service", `${duty.length} en service`);

    const openRow = rows.find((r) => r.endedAt === null)!;
    const cOpen = await correctShift(job, openRow.id, { startedAt: t(180), endedAt: t(60) });
    assert(!cOpen.ok && cOpen.error === "still_open", "service en cours non corrigeable", JSON.stringify(cOpen));

    const closedRow = rows.find((r) => r.endedAt !== null)!;
    const cInv = await correctShift(job, closedRow.id, { startedAt: t(60), endedAt: t(180) });
    assert(!cInv.ok && cInv.error === "inverted", "fin avant début refusée", JSON.stringify(cInv));
    const cLong = await correctShift(job, closedRow.id, { startedAt: t(60 * 40), endedAt: t(0) });
    assert(!cLong.ok && cLong.error === "too_long", "durée aberrante refusée", JSON.stringify(cLong));
    const cWrong = await correctShift("__autre_job", closedRow.id, { startedAt: t(180), endedAt: t(120) });
    assert(!cWrong.ok && cWrong.error === "not_found", "correction cloisonnée par métier", JSON.stringify(cWrong));

    const cOk = await correctShift(job, closedRow.id, { startedAt: t(180), endedAt: t(120) });
    assert(cOk.ok, "une correction valide passe", JSON.stringify(cOk));
    const after = await listShifts(job, { identifier: who });
    const fixed = after.find((r) => r.id === closedRow.id)!;
    assert(Math.abs(fixed.seconds - 3600) < 90, "la correction est appliquée", `${fixed.seconds}s`);
    assert(fixed.endedReason === "debauche", "le motif de fin n'est pas écrasé", `reçu ${fixed.endedReason}`);
  } finally {
    await cleanup();
    ok("nettoyage des pointages de vérification");
  }
}

/**
 * LA PART EMPLOYÉ ET LA GRILLE, en pur puis en base réelle.
 *
 * ⚠ CE QUE `tsc` NE PEUT PAS VOIR ICI, et c'est la raison d'être de cette section: la part employé
 * en pourcentage est calculée à DEUX endroits qui doivent tomber sur le même centime - le serveur
 * (`declareSale`, qui l'écrit) et la caisse (`CaisseView`, qui l'annonce avant d'écrire). Les deux
 * appellent `unitCommissionCents`, mais rien dans le type ne prouve que le serveur applique le taux
 * de la BONNE personne, ni qu'il retombe bien sur `items.commission_cents` en mode montant. Une
 * erreur ici ne lève aucune exception: elle produit une paie fausse, une semaine plus tard.
 */
function payModelChecks() {
  console.log("\nPart employé (pur)");

  const policy: CommissionPolicy = {
    mode: "pourcentage",
    bps: 5000,
    byEmployee: { aaaaaaaa11111111: 6500, bbbbbbbb22222222: 0 },
    vehicleProfitBps: 2000,
    byGrade: { "0": 500, "1": 1000 },
  };

  assert(rateFor(policy, "aaaaaaaa11111111") === 6500, "un accord personnel l'emporte", "accord ignoré");
  assert(rateFor(policy, "cccccccc33333333") === 5000, "sans accord, le taux de la maison", "repli faux");
  /**
   * ⚠ LE TEST QUI COMPTE VRAIMENT. `rateFor` utilise `??` et non `||`; avec `||`, un accord à 0 %
   * (un apprenti non commissionné, une décision réelle) retomberait sur le taux de la maison et
   * paierait quelqu'un que le patron a explicitement mis à zéro. Les deux écritures compilent et se
   * lisent pareil.
   */
  assert(rateFor(policy, "bbbbbbbb22222222") === 0, "un accord à 0 % est respecté", "0 confondu avec absent");
  assert(rateFor({ ...policy, mode: "montant" }, "aaaaaaaa11111111") === 0, "aucun taux en mode montant", "taux appliqué hors mode pourcentage");

  assert(unitCommissionCents(1250, 5000) === 625, "50 % de 12,50 $", "arrondi faux");
  assert(unitCommissionCents(999, 5000) === 500, "arrondi au plus proche, pas vers le bas", "troncature: l'employé perd un centime à chaque vente");
  assert(unitCommissionCents(1250, 0) === 0, "un taux nul ne paie rien", "part créée sans taux");

  assert(percentToBps("62,5") === null, "une virgule décimale n'est pas un nombre", "virgule acceptée en silence");
  assert(percentToBps("62.5") === 6250, "62.5 % vaut 6250 bps", "conversion fausse");
  assert(percentToBps("62.4999999") === 6250, "une saisie collée est ramenée au pas", "valeur qui change toute seule à l'affichage");
  assert(percentToBps("101") === null, "au-dessus de 100 % refusé", "un zéro de trop passe");
  assert(percentToBps("-1") === null, "un taux négatif refusé", "négatif accepté");

  // Repli en cascade: ce que le commerce a écrit, sinon son modèle, sinon le défaut historique.
  assert(
    resolveCommission(null, templateCommission("tatouage")).mode === "pourcentage",
    "un salon neuf hérite du pourcentage de son modèle",
    "le modèle tatouage ne propose pas de pourcentage",
  );
  assert(
    resolveCommission(null, templateCommission("bar")).mode === "montant",
    "un bar reste au montant fixe",
    "un modèle historique a changé de mode: la paie de tous ses commerces bouge",
  );
  assert(
    resolveCommission({ mode: "montant", bps: 0, byEmployee: {} }, templateCommission("tatouage")).mode === "montant",
    "une décision écrite l'emporte sur le modèle",
    "le modèle écrase ce que le commerce a décidé",
  );
  assert(
    resolveCommission("n'importe quoi", templateCommission("tatouage")).mode === "pourcentage",
    "une donnée illisible retombe sur le modèle sans lever",
    "une colonne éditée à la main fait tomber le résolveur d'accès de tout le portail",
  );

  // La liste blanche d'effectif: sans elle, un POST forgé remplit la colonne d'inconnus.
  const known = new Set(["aaaaaaaa11111111"]);
  const clean = sanitizeCommission(
    { mode: "pourcentage", bps: 5000, byEmployee: { aaaaaaaa11111111: 6000, dddddddd44444444: 9000 } },
    known,
  );
  assert(clean.ok && clean.policy.byEmployee.dddddddd44444444 === undefined, "un étranger au commerce est écarté", "identifiant inconnu stocké");
  assert(clean.ok && clean.policy.byEmployee.aaaaaaaa11111111 === 6000, "l'employé réel est conservé", "accord perdu");
  const redundant = sanitizeCommission(
    { mode: "pourcentage", bps: 5000, byEmployee: { aaaaaaaa11111111: 5000 } },
    known,
  );
  assert(
    redundant.ok && Object.keys(redundant.policy.byEmployee).length === 0,
    "un accord égal au taux de la maison n'est pas stocké",
    "la personne resterait figée quand la maison remonte son taux",
  );
  assert(!sanitizeCommission({ mode: "moitie", bps: 5000 }, known).ok, "un mode inventé est refusé", "mode arbitraire écrit en base");
  assert(!sanitizeCommission({ mode: "pourcentage", bps: 20000 }, known).ok, "un taux hors bornes est refusé", "taux > 100 % écrit en base");

  assert(rateForGrade(policy, 0) === 500, "un grade a son propre %", "byGrade ignore");
  assert(rateForGrade(policy, 1) === 1000, "grade 1 a 10 % du profit", "mauvais palier");
  assert(rateForGrade(policy, 3) === 0, "un grade absent vaut 0, jamais le taux boutique", "repli boutique sur une supercar");
  assert(rateForGrade({ ...policy, byGrade: { "0": 0 } }, 0) === 0, "un grade a 0 % est respecté", "0 confondu avec absent");
  assert(
    vehicleUnitCommissionCents(200_000, 1000) === 20_000,
    "10 % d'un benefice de 2 000 $ = 200 $",
    "formule voiture fausse",
  );
  /**
   * ⚠ LES TROIS ASSERTIONS QUI EMPECHENT LE BUG DU 2026-08-27 DE REVENIR.
   *
   * Il consistait a passer un PRIX la ou la fonction attend un BENEFICE. Les deux sont des entiers
   * positifs en centimes, donc rien ne l'aurait signale: le seul garde-fou possible est un test qui
   * fixe la semantique.
   */
  assert(vehicleUnitCommissionCents(0, 1000) === 0, "aucun benefice => aucune part", "part versee sur une marge nulle");
  assert(
    vehicleUnitCommissionCents(-5000, 1000) === 0,
    "une marge negative ne verse rien",
    "part versee sur une vente a perte",
  );
  assert(
    vehicleUnitCommissionCents(100_000, 15_000) === 100_000,
    "un taux au-dessus de 100 % plafonne au benefice",
    "l'entreprise paie plus que ce qu'elle gagne",
  );
  const grades = new Set([0, 1]);
  const kept = sanitizeCommission(
    { mode: "montant", bps: 0, vehicleProfitBps: 2000, byGrade: { "1": 1500, "9": 9999 } },
    known,
    grades,
  );
  assert(kept.ok && kept.policy.byGrade["9"] === undefined, "un grade hors echelle est ecarte", "grade invente stocke");
  assert(kept.ok && kept.policy.byGrade["1"] === 1500, "le grade reel est conserve", "accord de grade perdu");

  assert(templateSellsVehicles("concession"), "le modele concession vend des vehicules", "sellsVehicles absent");
  assert(!templateSellsVehicles("bar"), "un bar ne vend pas FleetRoster", "un bar ouvrirait le catalogue voitures");
  assert(fleetModelCount() >= 50, "le roster extrait n'est pas vide", `${fleetModelCount()} modeles`);
  assert(vehicleForJob("luxury", "zzzz_not_a_car") === null, "un modele inconnu est refuse", "voiture fantome");
  const sampleCar = vehiclesForJob("luxury")[0];
  assert(Boolean(sampleCar), "luxury a au moins un modele dans FleetRoster", "extract-fleet a rate luxury");
  if (sampleCar) {
    assert(
      vehicleForJob("bar", sampleCar.model) === null,
      "un metier qui n'est pas seller ne vend pas la voiture",
      "cloison sellers ignoree",
    );
  }

  console.log("\nCaisse en grille (pur)");
  const grid = templateGrid("tatouage");
  assert(grid !== null, "le modele tatouage declare une grille de caisse", "grille absente: la caisse retombe sur le choix d'articles");
  assert(templateGrid("bar") === null, "un bar n'a pas de grille", "un modele historique a gagne une caisse a saisie libre");
  if (grid) {
    assert(
      BUSINESS_TEMPLATES.find((t) => t.name === "tatouage")!.categories.some((c) => c.key === grid.category),
      "le rayon de la grille existe dans le modele",
      "les lignes de vente porteraient un rayon que le commerce ne declare pas",
    );
    // Le plafond de depart doit exister et etre positif: access.ts retombe dessus quand le commerce
    // n'a rien regle, donc un zero ferait refuser chaque vente d'un salon neuf sans que personne
    // comprenne pourquoi, puisque le patron n'a jamais rien touche.
    assert(
      Number.isInteger(grid.maxLineCents) && grid.maxLineCents > 0,
      "le modele porte un plafond de depart utilisable",
      `maxLineCents = ${grid.maxLineCents}`,
    );
  }
}

/** La caisse a saisie libre: ecrite pour de vrai par `declareFreeSale`, puis relue sur la ligne. */
async function payPathChecks() {
  console.log("\nCaisse a saisie libre (base reelle, donnees jetables)");
  const JOB = "__verify_biz_pct";
  const seller = "__verify_pct_hex";

  const cleanup = async () => {
    const rows = await db
      .select({ id: citadelBusinesses.id })
      .from(citadelBusinesses)
      .where(eq(citadelBusinesses.job, JOB));
    for (const r of rows) {
      const sales = await db
        .select({ id: citadelBusinessSales.id })
        .from(citadelBusinessSales)
        .where(eq(citadelBusinessSales.businessId, r.id));
      for (const s of sales) {
        await db.delete(citadelBusinessSaleLines).where(eq(citadelBusinessSaleLines.saleId, s.id));
      }
      await db.delete(citadelBusinessSales).where(eq(citadelBusinessSales.businessId, r.id));
      await db.delete(citadelBusinessItems).where(eq(citadelBusinessItems.businessId, r.id));
    }
    await db.delete(citadelBusinesses).where(eq(citadelBusinesses.job, JOB));
  };

  await cleanup();
  try {
    const res = await db.insert(citadelBusinesses).values({
      job: JOB,
      slug: "--verify-biz-pct",
      name: "Vérif Pourcentage",
      template: "tatouage",
      categories: [{ key: "tatouages", label: "Tatouages", tone: 1 }],
    });
    const bizId = insertedId(res);

    const grid = templateGrid("tatouage")!;

    // ⚠ Le PLAFOND est ce qui remplace le prix-en-base sur ce chemin. On le regle en base, jamais
    // dans la requete, et `access.lineMaxCents` est ce que le resolveur en fait.
    const ceilOk = await setLineCeiling(bizId, 300_00);
    assert(ceilOk.ok, "le plafond s'enregistre", JSON.stringify(ceilOk));
    assert(!(await setLineCeiling(bizId, 0)).ok, "un plafond a zero est refuse", "un salon bloque en silence");
    assert(!(await setLineCeiling(bizId, -5)).ok, "un plafond negatif est refuse", "valeur aberrante ecrite en base");

    // ⚠ `vehicleProfitBps` et `byGrade` sont OBLIGATOIRES sur CommissionPolicy depuis la caisse
    // mixte de la concession. Ce script ne les passait pas et ne compilait donc plus (deux erreurs
    // tsc pre-existantes, corrigees le 2026-08-21): un salon de tatouage ne vend pas de voiture,
    // donc la politique vehicule est neutre, mais elle doit etre PRESENTE.
    await setCommissionPolicy(bizId, {
      mode: "pourcentage",
      bps: 6000,
      byEmployee: { [seller]: 4000 },
      vehicleProfitBps: 0,
      byGrade: {},
    });
    const stored = await getCommissionPolicy(bizId, "tatouage");
    assert(stored.mode === "pourcentage" && stored.bps === 6000, "la politique est relue telle qu'ecrite", JSON.stringify(stored));
    assert(rateFor(stored, seller) === 4000, "l'accord personnel est relu", JSON.stringify(stored.byEmployee));

    const access: BusinessAccess = {
      ...fakeAccess({ tier: "service" }),
      businessId: bizId,
      template: "tatouage",
      identifier: seller,
      // Idem: `BusinessAccess.commission` porte les deux taux vehicule depuis la caisse mixte.
      commission: {
        mode: "pourcentage",
        bps: rateFor(stored, seller),
        vehicleBps: 0,
      },
      lineMaxCents: 300_00,
    };

    // 150 $ + 90 $ = 240 $, part a 40 % = 96 $. Aucun article n'existe: les prix viennent de la saisie.
    const sale = await declareFreeSale(access, grid, {
      lines: [
        { slot: 0, priceCents: 150_00 },
        { slot: 6, priceCents: 90_00 },
      ],
      clientRef: "verif-free-1",
    });
    assert(sale.ok && sale.totalCents === 240_00, "le total est la somme des prix saisis", JSON.stringify(sale));
    assert(sale.ok && sale.commissionCents === 96_00, "la part suit le taux DE CETTE PERSONNE", JSON.stringify(sale));

    // ⚠ AUCUN ARTICLE DE CATALOGUE N'A ETE CREE. C'est tout le point: un salon n'en a pas.
    assert(
      (await listItems(bizId, { includeInactive: true })).length === 0,
      "une vente a saisie libre ne cree aucun article",
      "le catalogue s'est rempli tout seul",
    );

    const [row] = await db
      .select({ id: citadelBusinessSales.id })
      .from(citadelBusinessSales)
      .where(eq(citadelBusinessSales.businessId, bizId));
    const lines = await saleLines(bizId, row!.id);
    assert(lines.length === 2, "les deux lignes sont ecrites", `${lines.length} ligne(s)`);
    assert(
      lines.every((l) => l.itemId === null),
      "une ligne saisie ne pointe aucun article",
      "item_id renseigne alors qu'aucun article n'existe",
    );
    /**
     * ⚠ LE LIBELLE EST FABRIQUE PAR LE SERVEUR a partir du numero de case, jamais recu du client:
     * il finit copie dans l'historique de tout le monde, et `topProducts` groupe dessus quand
     * `item_id` est nul. Un libelle venu du navigateur serait du texte arbitraire dans les chiffres
     * de la semaine.
     */
    assert(
      lines.some((l) => l.label === "Tatouage 1") && lines.some((l) => l.label === "Tatouage 7"),
      "le libelle vient du numero de case, cote serveur",
      lines.map((l) => l.label).join(" / "),
    );
    assert(
      lines.every((l) => l.category === grid.category && l.qty === 1),
      "rayon et quantite sont ceux de la grille",
      "rayon ou quantite inattendus",
    );
    assert(
      lines.reduce((n, l) => n + l.unitCommissionCents * l.qty, 0) === 96_00,
      "la somme des lignes egale la part du ticket",
      "invariant rompu: le detail et le total du ticket ne disent pas la meme chose",
    );

    // Idempotence: le meme geste renvoye ne cree pas un second ticket.
    const again = await declareFreeSale(access, grid, {
      lines: [
        { slot: 0, priceCents: 150_00 },
        { slot: 6, priceCents: 90_00 },
      ],
      clientRef: "verif-free-1",
    });
    assert(again.ok && again.duplicate === true, "rejeu detecte comme doublon", JSON.stringify(again));

    /**
     * ⚠⚠ LE PLAFOND EST LE SEUL GARDE-FOU DE CE CHEMIN, et ces trois refus sont ce qui le prouve.
     * La part employe est un POURCENTAGE de ce que l'employe vient de taper: sans plafond, "je tape
     * mon prix" est exactement "je tape ma paie".
     */
    const over = await declareFreeSale(access, grid, {
      // 301 $ et non 300,01 $: depuis que les montants doivent etre des dollars entiers, une valeur
      // a la virgule est refusee AVANT le plafond, et le test ne prouverait plus le plafond.
      lines: [{ slot: 0, priceCents: 301_00 }],
      clientRef: "verif-free-2",
    });
    assert(!over.ok && over.error === "over_ceiling", "un prix au-dessus du plafond est refuse", JSON.stringify(over));

    const noCeiling = await declareFreeSale({ ...access, lineMaxCents: null }, grid, {
      lines: [{ slot: 0, priceCents: 100 }],
      clientRef: "verif-free-3",
    });
    assert(
      !noCeiling.ok && noCeiling.error === "no_ceiling",
      "sans plafond resoluble, on refuse la vente",
      "un plafond absent s'est lu comme 'aucune limite'",
    );

    // ⚠ Deux lignes sur la MEME case: le contournement evident du plafond, si on les additionnait.
    const dup = await declareFreeSale(access, grid, {
      lines: [
        { slot: 3, priceCents: 300_00 },
        { slot: 3, priceCents: 300_00 },
      ],
      clientRef: "verif-free-4",
    });
    assert(!dup.ok && dup.error === "bad_slot", "une case ne peut paraitre qu'une fois", JSON.stringify(dup));

    const outside = await declareFreeSale(access, grid, {
      lines: [{ slot: grid.slots, priceCents: 100 }],
      clientRef: "verif-free-5",
    });
    assert(!outside.ok && outside.error === "bad_slot", "une case hors grille est refusee", JSON.stringify(outside));

    /**
     * ⚠ 1,5 CENTIME ET 1,50 $ SONT REFUSES, ET LE SECOND EST LE PLUS IMPORTANT. Un `Math.trunc` de
     * politesse acceptait 1.5 comme 1 centime, donc ecrivait un ticket que personne n'avait voulu;
     * et un montant non multiple de 100 se lit ARRONDI partout (`money()` rend des dollars entiers)
     * tout en etant enregistre a la virgule, un ecart permanent entre ce qu'on lit et ce qu'on doit.
     * Trouve par ce script, pas par relecture: les deux passaient tous les autres controles.
     */
    for (const bogus of [0, -100, 1.5, 150, Number.NaN]) {
      const r = await declareFreeSale(access, grid, {
        lines: [{ slot: 1, priceCents: bogus }],
        clientRef: `verif-free-bad-${bogus}`,
      });
      assert(!r.ok, `prix ${bogus} refuse`, JSON.stringify(r));
    }

    const flood = await declareFreeSale(access, grid, {
      lines: Array.from({ length: grid.slots + 5 }, (_, i) => ({ slot: i, priceCents: 100 })),
      clientRef: "verif-free-6",
    });
    assert(!flood.ok && flood.error === "too_many_lines", "plus de lignes que de cases est refuse", JSON.stringify(flood));

    // ⚠ La copie datee: remonter le taux ne reecrit pas ce qui a deja ete gagne.
    await setCommissionPolicy(bizId, {
      mode: "pourcentage",
      bps: 10_000,
      byEmployee: {},
      vehicleProfitBps: 10_000,
      byGrade: {},
    });
    const after = await saleLines(bizId, row!.id);
    assert(
      after.reduce((n, l) => n + l.unitCommissionCents * l.qty, 0) === 96_00,
      "un changement de taux ne reecrit pas le passe",
      "l'historique des parts a bouge sous les pieds de la paie",
    );

    // Module part eteint: aucune part ne s'accumule en silence pour reapparaitre au rallumage.
    const off: BusinessAccess = { ...access, modules: { ...access.modules, commissions: false } };
    const noShare = await declareFreeSale(off, grid, {
      lines: [{ slot: 9, priceCents: 100_00 }],
      clientRef: "verif-free-7",
    });
    assert(noShare.ok && noShare.commissionCents === 0, "module part eteint: aucune part", JSON.stringify(noShare));

    ok("nettoyage des donnees de verification");
  } finally {
    await cleanup();
  }
}

/* ── La fiche client (concession / garage) ────────────────────────────────────────────────────── */

/**
 * LA FICHE CLIENT: identite de l'acheteur, plaque, et ce que la voiture porte.
 *
 * Demande du proprietaire (2026-08-21). Quatre familles de defauts que RIEN d'autre ne peut prouver,
 * et qui echouent toutes en SILENCE:
 *
 *   1. LE MODELE DECIDE, ET LA CAISSE COMME LE SERVEUR LISENT LA MEME REGLE. Les deux appellent
 *      `clientRecordRequired`; le jour ou quelqu'un reecrit la condition d'un cote, l'ecran laisse
 *      valider ce que le serveur refuse, ou pire, l'inverse.
 *
 *   2. LES BORNES SE LISENT-ELLES VRAIMENT DANS LES FICHIERS DU JEU. `clientRecordBounds` retombe
 *      expres sur un repli quand `gs_identity/config.lua` est illisible, pour ne pas rendre la
 *      caisse inutilisable. Consequence: un chemin deplace ne casse rien de VISIBLE - la caisse
 *      marche, et se met a appliquer des bornes qui ne sont plus celles du jeu. Personne ne le
 *      remarque avant qu'un joueur ne se voie refuser une date que sa fiche d'identite accepte.
 *
 *   3. LE MIROIR DE `string.normalizeName` TIENT-IL. Le nom saisi ici DESIGNE un personnage dont
 *      `users.firstname` a ete ecrit par cette fonction Lua. Si les deux normalisations divergent,
 *      rien n'echoue: on ecrit juste des fiches que personne ne peut rapprocher du joueur.
 *
 *   4. `clientRecordView` DISTINGUE-T-ELLE ENCORE "introuvable" DE "d'origine". C'est LA valeur de
 *      toute la fonctionnalite: une plaque qui ne designe aucune voiture et une voiture sans aucune
 *      option s'affichent identiquement si quelqu'un simplifie ce tri-etat un jour.
 *
 * Pur: aucune base, aucun serveur de jeu.
 */
function clientRecordChecks() {
  console.log("\n- fiche client (concession / garage) -");

  /* 1. Le modele decide, jamais le navigateur. */
  // ⚠ Revirement proprietaire 2026-08-27: le garage etait `always`. Il tient desormais une
  // boutique de comptoir ("to sell kit de reparation juste like a supperette would"), donc la
  // fiche suit la VOITURE comme a la concession. L'invariant qui compte (tout ticket de customs
  // exige la fiche) est prouve plus bas, pour chaque modele `billsCustoms`.
  assert(
    templateClientRecord("garage") === "with-vehicle",
    "le garage exige la fiche des qu'une voiture est au ticket",
    `mode lu: ${templateClientRecord("garage")}`,
  );
  assert(
    templateClientRecord("concession") === "with-vehicle",
    "la concession exige la fiche des qu'une voiture est au ticket",
    `mode lu: ${templateClientRecord("concession")}`,
  );

  /* 1bis. Les customs (2026-08-27): garage ET concession, fiche obligatoire, rayons nommes. */
  assert(templateBillsCustoms("garage"), "le garage facture des customs", "billsCustoms absent");
  assert(
    templateBillsCustoms("concession"),
    "la concession facture des customs",
    "billsCustoms absent: le volet Customs du concessionnaire est mort",
  );
  for (const t of BUSINESS_TEMPLATES) {
    if (!t.billsCustoms) continue;
    // L'invariant du proprietaire ("customs with required customer info"): un ticket de customs
    // porte une voiture par construction (`declareCustomSale` passe true), donc le mode de fiche
    // du modele doit l'exiger. Un modele `billsCustoms` sans mode de fiche laisserait passer des
    // customs anonymes, la seule paperasse qui rende le ticket retrouvable.
    assert(
      clientRecordRequired(templateClientRecord(t.name), true),
      `modele ${t.name}: tout ticket de customs exige la fiche client`,
      `mode lu: ${String(templateClientRecord(t.name))}`,
    );
    // `declareCustomSale` range ses lignes sous les cles de customPricing. Sans ces rayons dans le
    // modele, une ligne s'affiche sous sa cle brute, sans libelle ni teinte ("labels, never ids").
    for (const key of ["performance", "esthetique"]) {
      assert(
        t.categories.some((c) => c.key === key),
        `modele ${t.name}: le rayon "${key}" existe pour les lignes de customs`,
        "une ligne de custom s'afficherait sous sa cle brute",
      );
    }
    // Grille et customs restent exclusifs: deux caisses a la fois derriere CaisseModes, pas trois.
    assert(
      !t.grid,
      `modele ${t.name}: pas de grille en plus des customs`,
      "la route caisse rendrait la grille et perdrait le volet Customs",
    );
  }
  // Le volet d'arrivee: un atelier s'ouvre sur ses customs, la concession sur sa boutique.
  assert(
    templateCaisseDefault("garage") === "customs" && templateCaisseDefault("concession") === "boutique",
    "volets d'arrivee: customs au garage, boutique a la concession",
    `lus: garage=${templateCaisseDefault("garage")}, concession=${templateCaisseDefault("concession")}`,
  );
  // Un modele qui vend FleetRoster declare le rayon vehicule: c'est le chip de la caisse Boutique
  // ET la cle sous laquelle `declareSale` range une ligne de vente de voiture. Sans lui, le garage
  // n'a aucun chemin cliquable vers son Mesa R et la ligne s'affiche sous sa cle brute.
  for (const t of BUSINESS_TEMPLATES) {
    if (!t.sellsVehicles) continue;
    assert(
      t.categories.some((c) => c.key === VEHICLE_CATEGORY_KEY),
      `modele ${t.name}: le rayon "${VEHICLE_CATEGORY_KEY}" existe pour les ventes de vehicules`,
      "pas de chip Vehicules, et une ligne vehicule s'afficherait sous sa cle brute",
    );
  }
  assert(
    templateClientRecord("bar") === null && templateClientRecord("tatouage") === null,
    "un bar et un salon n'exigent aucune fiche",
    "un commerce sans voiture reclamerait une plaque",
  );
  // Un mode inconnu ne jette pas: `clientRecordRequired` rend false, donc la contrainte
  // disparaitrait en silence sur ce modele-la.
  for (const t of BUSINESS_TEMPLATES) {
    if (t.clientRecord === undefined) continue;
    assert(
      t.clientRecord === "always" || t.clientRecord === "with-vehicle",
      `modele ${t.name}: mode de fiche valide`,
      `valeur inattendue: ${String(t.clientRecord)}`,
    );
  }

  /* La table de verite, celle que la caisse ET declareSale consultent. */
  assert(clientRecordRequired("always", false), "always: exigee sans voiture", "un garage laisserait passer");
  assert(clientRecordRequired("always", true), "always: exigee avec voiture", "incoherent");
  assert(
    !clientRecordRequired("with-vehicle", false),
    "with-vehicle: pas exigee sur un ticket boutique",
    "un porte-cles reclamerait une plaque, donc une plaque inventee",
  );
  assert(
    clientRecordRequired("with-vehicle", true),
    "with-vehicle: exigee des qu'une voiture est au ticket",
    "une voiture partirait sans acheteur identifie",
  );
  assert(!clientRecordRequired(null, true), "aucun mode: jamais exigee", "un bar reclamerait une fiche");

  /* 2. Les bornes viennent des fichiers du jeu, pas du repli. */
  const bounds = clientRecordBounds();
  const looksLikeFallback =
    bounds.maxNameLength === CLIENT_RECORD_BOUNDS_FALLBACK.maxNameLength &&
    bounds.lowestYear === CLIENT_RECORD_BOUNDS_FALLBACK.lowestYear &&
    bounds.highestYear === CLIENT_RECORD_BOUNDS_FALLBACK.highestYear;
  if (looksLikeFallback) {
    // Le repli porte les MEMES valeurs que le config.lua d'aujourd'hui, donc l'egalite ne prouve
    // rien a elle seule. Le masque du telephone, lui, n'existe QUE dans gcphone: s'il est resolu,
    // les fichiers du jeu sont bien lus.
    assert(
      bounds.phoneDigits !== null,
      "les bornes sont lues dans les fichiers du jeu",
      "aucune borne resolue: gs_identity/config.lua ET gcphone/config.lua sont introuvables depuis citadel/ (chemin ../fivem/server-data/resources). La caisse marche mais applique des bornes qui ne sont plus celles du jeu.",
    );
  } else {
    ok(
      "les bornes sont lues dans les fichiers du jeu",
      `nom<=${bounds.maxNameLength}, ${bounds.lowestYear}-${bounds.highestYear}, tel=${bounds.phoneDigits ?? "?"}`,
    );
  }

  /* 3. Le miroir de string.normalizeName (gs_base/lib/string/shared.lua). */
  const NAME_CASES: [string, string | null][] = [
    ["lame", "Lame"],
    ["PhiLIpE", "Philipe"],
    ["jean-pierre", "Jean-Pierre"], // chaque suite de lettres capitalisee independamment
    ["o'brien", "O'Brien"],
    ["van  der berg ", "Van Der Berg"], // espaces internes reduits, bords coupes
    ["Emile2", null], // un chiffre
    ["Emilé", null], // un accent: REFUS cote jeu, donc refus ici
    ["-jean", null], // separateur en bordure
    ["jean--pierre", null], // separateurs empiles
    ["", null],
    ["'", null], // aucune lettre
  ];
  for (const [input, want] of NAME_CASES) {
    const got = normalizePersonName(input, 20);
    const value = got.ok ? got.value : null;
    assert(
      value === want,
      `nom "${input}" -> ${want === null ? "refus" : want}`,
      `obtenu: ${value === null ? "refus" : value}`,
    );
  }
  assert(!normalizePersonName("a".repeat(21), 20).ok, "un nom trop long est refuse", "la colonne serait tronquee");

  /* La date: forme, bornes, et le jour du mois annee bissextile comprise. */
  const B: ClientRecordBounds = { maxNameLength: 20, lowestYear: 1910, highestYear: 2010, phoneDigits: 7 };
  const d1 = normalizeBirthdate("5/4/1988", B);
  assert(
    d1.ok && d1.value === "05/04/1988",
    "la date est normalisee en JJ/MM/AAAA",
    "deux formes de la meme date en base",
  );
  assert(
    normalizeBirthdate("12-04-1988", B).ok,
    "le tiret est accepte a la saisie",
    "une habitude de frappe ferait echouer une date valide",
  );
  assert(!normalizeBirthdate("1988-04-12", B).ok, "l'ordre ISO est refuse", "le 4 serait lu comme un jour");
  assert(!normalizeBirthdate("29/02/1999", B).ok, "29/02 d'une annee non bissextile est refuse", "jour inexistant");
  assert(normalizeBirthdate("29/02/2000", B).ok, "29/02/2000 est accepte", "2000 est bissextile (regle des 400)");
  assert(!normalizeBirthdate("31/04/1990", B).ok, "31 avril est refuse", "jour inexistant");
  assert(!normalizeBirthdate("01/01/1800", B).ok, "une annee hors bornes est refusee", "hors intervalle du jeu");
  assert(!normalizeBirthdate("01/13/1990", B).ok, "un mois superieur a 12 est refuse", "date impossible");

  /* Le telephone: la mise en forme est jetee, pas refusee. */
  const p1 = normalizePhone("555-0134", B);
  assert(p1.ok && p1.value === "5550134", "le tiret est jete, pas refuse", JSON.stringify(p1));
  const p2 = normalizePhone(" 555 01 34 ", B);
  assert(p2.ok && p2.value === "5550134", "les espaces sont jetes", JSON.stringify(p2));
  assert(
    !normalizePhone("55501", B).ok,
    "un numero trop court est refuse quand le masque est connu",
    "longueur non conforme au masque gcphone",
  );
  assert(!normalizePhone("555O134", B).ok, "une lettre est refusee", "un O au lieu d'un zero passerait");

  /* La plaque: majuscules, espaces internes conserves. */
  const pl = normalizePlate(" 46eek572 ");
  assert(pl.ok && pl.value === "46EEK572", "la plaque est mise en majuscules et coupee aux bords", JSON.stringify(pl));
  const pl2 = normalizePlate("11 abc12");
  assert(
    pl2.ok && pl2.value === "11 ABC12",
    "un espace INTERNE est conserve",
    "le retirer fabriquerait une plaque qui n'existe pas",
  );
  assert(!normalizePlate("46EEK5721").ok, "une plaque de plus de 8 caracteres est refusee", "hors format GTA");
  assert(!normalizePlate("46-EEK").ok, "un caractere hors A-Z 0-9 espace est refuse", "plaque impossible");

  /* La fiche entiere nomme le PREMIER champ fautif, pas une liste. */
  const bad1 = checkClientRecord({ firstname: "Jean", lastname: "", dob: "", phone: "", plate: "" }, B);
  assert(!bad1.ok && bad1.field === "lastname", "la fiche nomme le premier champ fautif", JSON.stringify(bad1));
  const good = checkClientRecord(
    { firstname: "jean", lastname: "o'brien", dob: "5/4/1988", phone: "555 0134", plate: "46eek572" },
    B,
  );
  assert(
    good.ok &&
      good.value.firstname === "Jean" &&
      good.value.lastname === "O'Brien" &&
      good.value.dob === "05/04/1988" &&
      good.value.phone === "5550134" &&
      good.value.plate === "46EEK572",
    "une fiche valide ressort entierement normalisee",
    JSON.stringify(good),
  );

  /* 4. LE TRI-ETAT. Introuvable, illisible, sans fiche d'apparence, et d'origine: QUATRE lectures
        distinctes, dont trois porteraient a tort la mention "aucune modification" si on les
        confondait. C'est la raison d'etre de `vehicleNote`. */
  const base = { firstname: "Jean", lastname: "Dupont", dob: "05/04/1988", phone: "5550134", plate: "46EEK572" };
  const absent = clientRecordView({
    ...base,
    vehicle: { record: "absent", modelLabel: null, classLabel: null, fleetJob: null, mods: null },
  });
  assert(
    absent?.vehicleNote !== null && absent?.modsMissing === true,
    "une plaque introuvable est DITE, pas silencieuse",
    "elle s'afficherait comme une voiture d'origine",
  );
  const unreadable = clientRecordView({
    ...base,
    vehicle: { record: "unreadable", modelLabel: null, classLabel: null, fleetJob: null, mods: null },
  });
  assert(unreadable?.vehicleNote !== null, "un vehicule illisible est DIT", "confondu avec une voiture d'origine");
  const noAppearance = clientRecordView({
    ...base,
    vehicle: {
      record: "found",
      modelLabel: "Sultan",
      classLabel: "Sports",
      fleetJob: null,
      // 10 lignes de production sur 26 sont dans cet etat (voir VehicleMods.record): la ligne
      // existe, le blob ne porte AUCUNE apparence. C'est un enregistrement MANQUANT.
      mods: { summary: [], total: 0, record: "none" },
    },
  });
  assert(
    noAppearance?.vehicleNote !== null,
    "un vehicule sans fiche d'apparence est DIT manquant",
    "il s'afficherait comme une voiture d'origine, ce qui est un mensonge tranquille",
  );
  const stock = clientRecordView({
    ...base,
    vehicle: {
      record: "found",
      modelLabel: "Sultan",
      classLabel: "Sports",
      fleetJob: null,
      mods: { summary: [], total: 0, record: "full" },
    },
  });
  assert(
    stock?.vehicleNote === null && stock?.modsTotal === 0 && stock?.modsMissing === false,
    "une voiture reellement d'origine ne porte AUCUN avertissement",
    "un avertissement partout ne se lit plus nulle part",
  );
  const modded = clientRecordView({
    ...base,
    vehicle: {
      record: "found",
      modelLabel: "Sultan",
      classLabel: "Sports",
      fleetJob: null,
      mods: { summary: ["moteur niveau 4", "Noir mat"], total: 12, record: "full" },
    },
  });
  assert(
    modded?.vehicle === "Sultan · Sports" && modded?.modsTotal === 12 && modded.mods.length === 2,
    "une voiture modifiee rend son modele et ses pastilles",
    JSON.stringify(modded),
  );
  assert(clientRecordView(null) === null, "aucune fiche rend null", "une fiche vide serait fabriquee");
}

async function main() {
  modelChecks();
  artChecks();
  gateChecks();
  payModelChecks();
  clientRecordChecks();
  await queryChecks();
  await salePathChecks();
  await payPathChecks();
  await shiftChecks();
  console.log(failures === 0 ? "\nTout est cohérent.\n" : `\n${failures} ÉCHEC(S).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
