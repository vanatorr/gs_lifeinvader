import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { citadelBusinesses } from "@/lib/db/schema/citadel";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug } from "@/lib/business/access";
import { CAP, FALLBACK_CAPS } from "@/lib/business/capabilities";
import { listItems } from "@/lib/business/catalogue";
import { getTemplate } from "@/lib/business/templates";
import { gradesForJob } from "@/lib/data/gameCommands";
import ReglagesView from "./ReglagesView";

export const dynamic = "force-dynamic";

/**
 * LES RÉGLAGES: modules, rayons, distribution des droits par grade.
 *
 * ⚠ LA PAGE RE-RÉSOUT SON ACCÈS ELLE-MÊME, même paire de raisons que partout ailleurs sous
 * `/business`: un layout n'est pas une frontière, et la page a pu rester ouverte pendant qu'on
 * quittait son service. `hasAccess` (le GRADE a-t-il un jour reçu `SETTINGS_WRITE`) et `canWrite`
 * (palier "en service" en plus) sont deux questions séparées, même répartition que
 * `gestion/catalogue/page.tsx` et `gestion/pointage/page.tsx`.
 *
 * ⚠ CETTE PAGE LIT `lifeinvader_businesses.grants` DIRECTEMENT, ce que `getBusinessAccess` n'expose pas:
 * il ne porte que les capacités déjà RÉSOLUES pour LA personne connectée, jamais la table complète
 * qu'un patron doit voir pour la redistribuer. Ce n'est pas un nouveau chemin de lecture des
 * commerces (la règle "lifeinvader_businesses ne doit être lue QUE par getBusinessAccess" vise la
 * DÉCOUVERTE de commerces, voir lib/business/access.ts) - c'est un champ de plus sur un commerce déjà
 * résolu et cloisonné par `businessId`.
 */
export default async function ReglagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const hasAccess = access.capabilities.has(CAP.SETTINGS_WRITE);
  if (!hasAccess) {
    return (
      <ReglagesView
        slug={access.slug}
        name={access.name}
        hasAccess={false}
        canWrite={false}
        writeReason={null}
        templateLabel={access.template}
        templateModules={{}}
        moduleOverrides={{}}
        modules={{}}
        categories={[]}
        categoryCounts={{}}
        grades={[]}
        bossGradeLabel={null}
        initialGrants={{}}
        hadCustomGrants={false}
      />
    );
  }

  const [gradesRaw, [row], items] = await Promise.all([
    gradesForJob(access.job),
    db
      .select({ grants: citadelBusinesses.grants })
      .from(citadelBusinesses)
      .where(eq(citadelBusinesses.id, access.businessId))
      .limit(1),
    // ⚠ `includeInactive: true` VOLONTAIREMENT. Ces comptes servent à dire si un rayon peut être
    // retiré, et `setCategories` refuse le retrait dès qu'un article PORTE ce rayon, archivé ou pas
    // (son `selectDistinct` ne filtre pas sur `active`). Compter seulement les articles en vente
    // afficherait "0 article" sur un rayon dont la suppression échouera, ce qui est pire qu'un
    // bouton grisé: on cliquerait, ça refuserait, et rien n'expliquerait pourquoi.
    listItems(access.businessId, { includeInactive: true }),
  ]);

  // ⚠⚠ LE GRADE PATRON N'APPARAÎT JAMAIS DANS CETTE LISTE. Il détient tout, implicitement et
  // irrévocablement (voir catalogue.ts `setGrants`, qui de toute façon retire ce grade avant
  // d'écrire quoi que ce soit) - un NOM, jamais un indice de tableau.
  const grades = gradesRaw.filter((g) => !g.isBoss).map((g) => ({ grade: g.grade, label: g.label }));
  // Son LIBELLÉ, lui, se dit en clair: "le patron a tout" est une phrase creuse quand personne ne
  // sait quel échelon porte ce nom dans ce métier.
  const bossGradeLabel = gradesRaw.find((g) => g.isBoss)?.label ?? null;

  /** Combien d'articles portent chaque rayon, y compris ceux qui ne sont plus déclarés. */
  const categoryCounts: Record<string, number> = {};
  for (const it of items) categoryCounts[it.category] = (categoryCounts[it.category] ?? 0) + 1;

  const storedGrants = row?.grants ?? null;
  const hadCustomGrants = storedGrants !== null;

  /**
   * ⚠ POURQUOI ON MATÉRIALISE LE REPLI JOUR-UN AU LIEU DE LAISSER LES CASES VIDES.
   *
   * `setGrants` réécrit `grants` EN ENTIER (voir son commentaire). Tant que la colonne est `null`,
   * chaque grade profite de `FALLBACK_CAPS` (encaisser, voir ses ventes, voir le catalogue) - un
   * état TOUT-OU-RIEN au niveau du commerce, pas grade par grade (voir `getBusinessAccess`:
   * `biz.grants ? new Set(biz.grants[grade] ?? []) : FALLBACK_CAPS`). Si l'écran partait de cases
   * vides et qu'un patron ne cochait QUE le grade qui l'intéresse avant d'enregistrer, `grants`
   * passerait de `null` à un objet non-null: TOUS LES AUTRES GRADES perdraient alors le repli
   * jour-un d'un coup, silencieusement, parce qu'un grade absent d'un objet non-null vaut désormais
   * un ensemble VIDE et non plus le repli. On rend donc explicite, au moment même où l'écran se
   * construit, ce qui est déjà vrai en pratique: chaque grade non encore configuré part avec
   * `FALLBACK_CAPS` pré-cochées, pas avec rien.
   */
  const initialGrants: Record<string, string[]> = {};
  for (const g of grades) {
    const key = String(g.grade);
    initialGrants[key] = storedGrants ? (storedGrants[key] ?? []) : Array.from(FALLBACK_CAPS);
  }

  const tpl = getTemplate(access.template);
  const canWrite = businessCan(access, CAP.SETTINGS_WRITE);

  return (
    <ReglagesView
      slug={access.slug}
      name={access.name}
      hasAccess
      canWrite={canWrite}
      // `settings.write` n'appartient à AUCUN module (anti-enfermement, voir modules.ts) et
      // `hasAccess` a déjà prouvé que le grade le détient: le seul refus possible restant est le
      // palier de présence. On le nomme au lieu de laisser un bouton grisé sans motif.
      writeReason={canWrite ? null : "Prenez votre service en jeu: modifier les réglages exige d'être pointé."}
      templateLabel={tpl?.label ?? access.template}
      templateModules={tpl?.modules ?? {}}
      moduleOverrides={access.moduleOverrides}
      // L'état EFFECTIF (essentiels, puis modèle, puis écarts) sert à dire, dans la table des
      // droits, qu'une capacité est accordée mais inerte parce que son module est éteint.
      modules={access.modules}
      categories={access.categories}
      categoryCounts={categoryCounts}
      grades={grades}
      bossGradeLabel={bossGradeLabel}
      initialGrants={initialGrants}
      hadCustomGrants={hadCustomGrants}
    />
  );
}
