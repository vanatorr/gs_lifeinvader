/**
 * OUVRIR LES PORTAILS LIFEINVADER DES CONCESSIONNAIRES (local).
 *
 *   npm run business:seed:dealers
 *
 * Un modèle `concession` pour tous: caisse mixte (FleetRoster filtré par métier + boutique
 * d'articles). Les voitures ne sont PAS recopiées en articles. Le patron règle ensuite
 * marge + % par grade depuis Catalogue.
 *
 * Idempotent: un métier déjà activé n'est pas réécrit (catalogue, droits, rayons intacts).
 * Un métier absent de `jobs` est ignoré, pas une erreur fatale: on active ce qui existe.
 *
 * ⚠ RATTRAPAGE 2026-08-27: la même exécution AJOUTE les rayons STRUCTURELS manquants à TOUS les
 * commerces déjà ouverts, quel que soit leur modèle (une concession activée depuis Réseau y a
 * droit aussi). Structurel = un rayon où le serveur range des lignes de son propre chef:
 * `performance` + `esthetique` quand le modèle facture des customs (`declareCustomSale`), et
 * `vehicules` quand il vend FleetRoster (`declareSale`, VEHICLE_CATEGORY_KEY). Les rayons sont
 * copiés sur la ligne du commerce à l'activation, donc un ajout au modèle n'atteint jamais un
 * commerce existant tout seul; sans ce rattrapage, une ligne s'afficherait sous sa clé brute et le
 * chip Véhicules du garage n'existerait pas. On APPEND ce qui manque, on ne réécrit ni ne
 * réordonne rien: les rayons appartiennent au patron dès l'activation. À rejouer sur la base de
 * PROD au déploiement de ce volet, même commande.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelBusinesses } from "@/lib/db/schema/citadel";
import { jobs } from "@/lib/db/schema/game";
import { insertedId } from "@/lib/db/insertId";
import { getTemplate, templateSeed, type BusinessCategory } from "@/lib/business/templates";
import { vehiclesForJob } from "@/lib/business/fleet";

const TEMPLATE = "concession";

const DEALERS: { job: string; slug: string; name: string }[] = [
  { job: "luxury", slug: "luxury-autos", name: "Luxury Autos" },
  { job: "cardealer", slug: "pdm", name: "Premium Deluxe Motorsport" },
  { job: "motodealer", slug: "sanders", name: "Sanders Motorcycles" },
  { job: "flywheels", slug: "flywheels", name: "Flywheels" },
  { job: "northmarina", slug: "north-marina", name: "North Marina" },
  { job: "docktease", slug: "dock-tease", name: "DockTease" },
];

function slugifyFallback(job: string): string {
  return job.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function main() {
  if (!getTemplate(TEMPLATE)) {
    console.error(`Modele "${TEMPLATE}" absent. Rien fait.`);
    process.exit(1);
  }
  const seed = templateSeed(TEMPLATE);
  let opened = 0;
  let skipped = 0;

  for (const d of DEALERS) {
    const [row] = await db.select({ name: jobs.name, label: jobs.label }).from(jobs).where(eq(jobs.name, d.job)).limit(1);
    if (!row) {
      console.log(`Ignoré: métier ${d.job} absent de jobs`);
      skipped++;
      continue;
    }

    const [existing] = await db.select().from(citadelBusinesses).where(eq(citadelBusinesses.job, d.job)).limit(1);
    const n = vehiclesForJob(d.job).length;
    if (existing) {
      console.log(`Déjà ouvert #${existing.id}: ${existing.name} (${d.job}, ${n} véhicules) -> /business/${existing.slug}/caisse`);
      skipped++;
      continue;
    }

    const name = d.name || row.label || d.job;
    const slug = d.slug || slugifyFallback(d.job);
    const res = await db.insert(citadelBusinesses).values({
      job: d.job,
      slug,
      name,
      template: TEMPLATE,
      palette: seed.palette,
      categories: seed.categories,
    });
    console.log(`Ouvert #${insertedId(res)}: ${name} (${d.job}, ${n} véhicules) -> /business/${slug}/caisse`);
    opened++;
  }

  console.log(`Terminé: ${opened} ouvert(s), ${skipped} ignoré(s)/déjà là.`);

  /* Rattrapage des rayons structurels sur tous les commerces déjà ouverts (voir l'entête). */
  const open = await db
    .select({
      id: citadelBusinesses.id,
      name: citadelBusinesses.name,
      template: citadelBusinesses.template,
      categories: citadelBusinesses.categories,
    })
    .from(citadelBusinesses);
  let topped = 0;
  let covered = 0;
  for (const b of open) {
    const tpl = getTemplate(b.template);
    if (!tpl) continue;
    const structuralKeys = [
      ...(tpl.billsCustoms ? ["performance", "esthetique"] : []),
      ...(tpl.sellsVehicles ? ["vehicules"] : []),
    ];
    if (structuralKeys.length === 0) continue;
    covered++;
    const cats: BusinessCategory[] = Array.isArray(b.categories) ? (b.categories as BusinessCategory[]) : [];
    // La définition (libellé, teinte, icône) vient du MODÈLE du commerce, pas d'une table à part:
    // c'est lui qui déclare ces rayons, verify:business l'exige.
    const missing = tpl.categories.filter(
      (c) => structuralKeys.includes(c.key) && !cats.some((x) => x.key === c.key),
    );
    if (missing.length === 0) continue;
    // Avant "divers" quand il existe, pour suivre l'ordre du modèle; sinon à la fin.
    const at = cats.findIndex((c) => c.key === "divers");
    const next = at === -1 ? [...cats, ...missing] : [...cats.slice(0, at), ...missing, ...cats.slice(at)];
    await db.update(citadelBusinesses).set({ categories: next }).where(eq(citadelBusinesses.id, b.id));
    console.log(`Rayons ajoutés à #${b.id} ${b.name} (${b.template}): ${missing.map((m) => m.key).join(", ")}`);
    topped++;
  }
  console.log(`Rattrapage rayons structurels: ${topped} commerce(s) complété(s), ${covered - topped} déjà à jour.`);
  console.log("Ensuite: Catalogue -> régler la marge et le % du profit par grade.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
