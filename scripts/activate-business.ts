/**
 * ACTIVER LE PORTAIL POUR UN MÉTIER.
 *
 * L'activation est une DÉCISION EXPLICITE, jamais un effet de bord: il y a ~130 métiers dans `jobs`,
 * et un métier absent de `lifeinvader_businesses` n'a simplement pas de portail. Sans ce choix, chaque
 * métier ajouté au jeu ouvrirait silencieusement une boutique au catalogue vide.
 *
 *   npm run business:activate -- <job> [--template=bar] [--name="Bar du Vigneron"] [--slug=bar-du-vigneron]
 *
 * Idempotent: relancer sur un métier déjà activé met à jour l'enseigne et le modèle, mais NE TOUCHE
 * NI au catalogue, NI aux droits, NI aux rayons - ce sont des données que le commerce s'est
 * appropriées, et les réécrire depuis un script effacerait le travail du patron.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelBusinesses } from "@/lib/db/schema/citadel";
import { jobs } from "@/lib/db/schema/game";
import { insertedId } from "@/lib/db/insertId";
import { BUSINESS_TEMPLATES, getTemplate, templateSeed } from "@/lib/business/templates";

/**
 * Le slug d'URL, dérivé de l'enseigne.
 *
 * ⚠ Les apostrophes et les accents ne sont pas des SÉPARATEURS. Une première version faisait
 * `[^a-z0-9]+ -> "-"`, ce qui transformait "Benny's Motorworks" en `benny-s-motorworks`. On dépose
 * donc les accents, on SUPPRIME les apostrophes, et seul ce qui reste devient un tiret.
 */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const job = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!job) {
    console.error("usage: npm run business:activate -- <job> [--template=bar] [--name=...] [--slug=...]");
    console.error(`modèles: ${BUSINESS_TEMPLATES.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  // Le métier doit EXISTER en jeu. Activer un portail sur un métier inventé produirait une enseigne
  // que personne ne peut jamais voir, puisque l'appartenance se lit dans `users.job`.
  const [row] = await db.select({ name: jobs.name, label: jobs.label }).from(jobs).where(eq(jobs.name, job)).limit(1);
  if (!row) {
    console.error(`Le métier "${job}" n'existe pas dans la table jobs. Rien fait.`);
    process.exit(1);
  }

  const template = arg("template") ?? "commerce";
  if (!getTemplate(template)) {
    console.error(`Modèle inconnu "${template}". Connus: ${BUSINESS_TEMPLATES.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  const name = arg("name") ?? row.label ?? job;
  const slug = arg("slug") ?? (slugify(name) || job);
  const seed = templateSeed(template);

  const [existing] = await db.select().from(citadelBusinesses).where(eq(citadelBusinesses.job, job)).limit(1);
  if (existing) {
    await db
      .update(citadelBusinesses)
      .set({ name, template, active: true })
      .where(eq(citadelBusinesses.id, existing.id));
    console.log(`Mis à jour: ${name} (${job}) -> /business/${existing.slug}/caisse`);
    console.log("Catalogue, rayons et droits laissés intacts.");
    return;
  }

  const res = await db.insert(citadelBusinesses).values({
    job,
    slug,
    name,
    template,
    palette: seed.palette,
    // Les rayons sont MATÉRIALISÉS depuis le modèle et appartiennent ensuite au commerce: un article
    // désigne son rayon par son NOM, donc un modèle qui renommerait un rayon plus tard rendrait
    // orphelins tous les articles de tous les commerces adossés à lui.
    categories: seed.categories,
    // `grants` reste NULL exprès: null veut dire "jamais configuré" et déclenche le repli jour-un,
    // alors que `{}` voudrait dire "tout retiré à tout le monde".
  });

  console.log(`Activé #${insertedId(res)}: ${name} (${job}, modèle ${template})`);
  console.log(`  -> /business/${slug}/caisse`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
