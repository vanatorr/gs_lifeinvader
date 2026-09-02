import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug, type BusinessAccess } from "@/lib/business/access";
import { CAP, type Capability } from "@/lib/business/capabilities";
import { getCommissionPolicy, listItems } from "@/lib/business/catalogue";
import { DEFAULT_COMMISSION } from "@/lib/business/commission";
import { moduleOfCapability } from "@/lib/business/modules";
import { employeesForJob } from "@/lib/business/roster";
import { gradesForJob } from "@/lib/data/gameCommands";
import { templateGrid, templateSellsVehicles, VEHICLE_CATEGORY_KEY } from "@/lib/business/templates";
import CatalogueView from "./CatalogueView";
import TarifsView from "./TarifsView";
import PartEmploye, { type PartEmployeMember } from "./PartEmploye";

export const dynamic = "force-dynamic";

/**
 * LE CATALOGUE, côté gestion.
 *
 * ⚠⚠ DEUX ÉCRANS DERRIÈRE UNE SEULE ROUTE, choisis par le MODÈLE du commerce et jamais par le
 * navigateur. `CatalogueView` tient des ARTICLES, avec leurs prix, pour un commerce ordinaire.
 * `TarifsView` n'en tient AUCUN: un commerce en grille (le salon de tatouage) a une caisse à saisie
 * libre où l'EMPLOYÉ tape le prix de chaque pièce, donc la direction n'y fixe pas des prix - elle
 * fixe une BORNE (le plafond par ligne) et un PARTAGE (la part employé). Voir `BusinessGrid`
 * (lib/business/templates.ts) et `CaisseGrilleView`.
 *
 * ⚠ CONTRAIREMENT À LA CAISSE (`listItems(id)`, actifs seulement), cette page lit AUSSI les articles
 * archivés (`includeInactive: true`): c'est le seul endroit du portail qui doit pouvoir les
 * réactiver, donc le seul qui a besoin de les revoir.
 *
 * ⚠ LA PAGE RE-RÉSOUT SON ACCÈS ELLE-MÊME (`getBusinessBySlug` puis `notFound()` si absent), même si
 * la mise en page parente l'a déjà fait: Next peut rendre cette page sans son layout lors d'une
 * navigation côté client. Même discipline que `caisse/page.tsx` et `gestion/pointage/page.tsx`.
 *
 * ⚠⚠ DEUX CAPACITÉS DISTINCTES, PAS UNE SEULE, ET C'EST UN CHANGEMENT DE 2026-08-08. La page
 * exigeait `CATALOGUE_WRITE` pour tout, y compris pour REGARDER: un employé qui a le droit de lire la
 * carte des prix (`CATALOGUE_READ`, palier "session", accordé par le repli jour-un à tout le monde)
 * recevait une page qui lui disait qu'il n'avait pas accès. Désormais la LECTURE ouvre la carte
 * entière et l'ÉCRITURE ouvre les contrôles, avec le motif affiché quand elle manque. Un bouton grisé
 * qui explique vaut mieux qu'une page vide, et une page vide vaut mieux qu'une page qui ment.
 */

/**
 * POURQUOI une capacité est refusée, en une formule que la personne peut suivre.
 *
 * ⚠ NE PAS DEVINER LA CAUSE. `businessCan` échoue pour TROIS raisons distinctes, et affirmer toujours
 * la dernière envoie quelqu'un prendre son service pour rien, sans jamais lui dire que c'est son
 * grade qui bloque ni à qui le demander. Même fonction, même raisonnement que `[slug]/layout.tsx`:
 * dupliquée plutôt qu'exportée depuis la mise en page, qui n'est pas un module de logique.
 */
function whyBlocked(a: BusinessAccess, cap: Capability, moduleLabel: string): string {
  const mod = moduleOfCapability(cap);
  // Le module `catalogue` est `core`, donc `resolveModules` le force allumé et cette branche ne peut
  // pas se produire aujourd'hui. Elle est écrite quand même: le jour où quelqu'un le rend
  // extinguible, le message correct existe déjà, plutôt qu'un refus qui accuse la prise de service.
  if (mod && a.modules[mod] === false) return `${moduleLabel} désactivé pour ce commerce.`;
  if (!a.capabilities.has(cap)) {
    return "Votre grade n'a pas ce droit dans ce commerce. Demandez-le à la direction, qui le distribue par grade depuis les Réglages.";
  }
  return "Prenez votre service en jeu: toute modification du catalogue exige d'être pointé.";
}

export default async function CataloguePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const grid = templateGrid(access.template);
  const canRead = businessCan(access, CAP.CATALOGUE_READ);

  if (!canRead) {
    // Aucune donnée n'est chargée: sans le droit de lecture, la page se ferme et dit pourquoi. Elle
    // n'affiche jamais une carte vide, qui se lirait comme "ce commerce n'a rien à vendre".
    const reason = whyBlocked(access, CAP.CATALOGUE_READ, "Catalogue");
    return grid ? (
      <TarifsView
        slug={access.slug}
        name={access.name}
        canRead={false}
        readReason={reason}
        canWrite={false}
        writeReason={null}
        labelPrefix={grid.labelPrefix}
        slots={grid.slots}
        lineMaxCents={null}
        commission={DEFAULT_COMMISSION}
        members={[]}
      />
    ) : (
      <CatalogueView
        slug={access.slug}
        name={access.name}
        canRead={false}
        readReason={reason}
        canWrite={false}
        writeReason={null}
        items={[]}
        categories={[]}
        showCommission={false}
        showVisuals={false}
      />
    );
  }

  const canWrite = businessCan(access, CAP.CATALOGUE_WRITE);
  const writeReason = canWrite ? null : whyBlocked(access, CAP.CATALOGUE_WRITE, "Catalogue");

  /**
   * ⚠ LE PANNEAU DE PART EMPLOYÉ N'EXISTE QUE SI LE MODULE `commissions` EST ALLUMÉ. Ce module décide
   * si la part EXISTE pour ce commerce (voir modules.ts), et `declareSale` met la part à zéro quand
   * il est éteint: offrir l'écran quand même laisserait régler un taux qui ne serait jamais appliqué.
   *
   * ⚠ L'EFFECTIF EST LU MÊME SANS LE DROIT D'ÉCRIRE. Ce n'est PAS `team.read`: cette liste ne porte
   * ni chiffre d'affaires, ni heures, ni part gagnée - seulement des noms, des grades et le taux
   * négocié, qui sont exactement ce que le panneau règle. La donnée sensible que `team.read` protège
   * (ce que les collègues ont vendu) n'apparaît nulle part ici.
   */
  const withCommission = access.modules.commissions !== false;
  const [policy, roster, ladder] = await Promise.all([
    withCommission ? getCommissionPolicy(access.businessId, access.template) : null,
    withCommission ? employeesForJob(access.job) : Promise.resolve([]),
    withCommission && templateSellsVehicles(access.template)
      ? gradesForJob(access.job)
      : Promise.resolve([]),
  ]);
  const members: PartEmployeMember[] = roster.map((r) => ({
    identifier: r.identifier,
    name: r.name,
    gradeLabel: r.gradeLabel,
  }));

  /**
   * ⚠ UN COMMERCE EN GRILLE N'A PAS DE CATALOGUE DU TOUT, donc rien à lire: sa caisse est une saisie
   * libre (voir `BusinessGrid`). On sort AVANT `listItems`, plutôt que de charger une liste vide pour
   * la jeter - et surtout pour que personne ne prenne l'habitude de croire qu'il en existe une.
   */
  if (grid) {
    return (
      <TarifsView
        slug={access.slug}
        name={access.name}
        canRead
        readReason={null}
        canWrite={canWrite}
        writeReason={writeReason}
        labelPrefix={grid.labelPrefix}
        slots={grid.slots}
        lineMaxCents={access.lineMaxCents}
        commission={policy ?? DEFAULT_COMMISSION}
        members={members}
      />
    );
  }

  const items = await listItems(access.businessId, { includeInactive: true });
  const itemCategories = access.categories.filter((c) => c.key !== VEHICLE_CATEGORY_KEY);

  return (
    <CatalogueView
      slug={access.slug}
      name={access.name}
      canRead
      readReason={null}
      canWrite={canWrite}
      writeReason={writeReason}
      items={items}
      categories={itemCategories}
      /**
       * ⚠ LA COLONNE "PART" DES FICHES ARTICLE DISPARAÎT EN MODE POURCENTAGE, et ce n'est pas de
       * l'esthétique: `declareSale` ignore `items.commission_cents` dès que le commerce paie au
       * pourcentage, donc laisser le champ afficherait un montant qu'on peut modifier et qui ne
       * paie personne. La valeur reste EN BASE, intacte, et réapparaît si le commerce revient au
       * montant fixe (voir `setSlots`, même raisonnement).
       */
      showCommission={withCommission && (policy?.mode ?? "montant") === "montant"}
      // Le module "Visuels produits" décide si la CAISSE dessine une plaque. La page de gestion suit
      // la même règle: montrer ici un dessin que le client ne verra jamais mentirait sur son seul
      // travail. Le sélecteur, lui, reste ouvert et l'explique (voir ItemEditor).
      showVisuals={access.modules.visuels !== false}
      payPanel={
        policy ? (
          <PartEmploye
            slug={access.slug}
            canWrite={canWrite}
            writeReason={writeReason}
            initial={policy}
            members={members}
            sampleCents={items.find((i) => i.active && i.priceCents > 0)?.priceCents ?? null}
            vehicleGrades={ladder.map((g) => ({ grade: g.grade, label: g.label }))}
          />
        ) : null
      }
    />
  );
}
