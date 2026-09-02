import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Network, Store } from "lucide-react";
import { requireIdentity } from "@/lib/auth/session";
import { getBusinessAccess, type BusinessAccess } from "@/lib/business/access";
import { isNetworkAdmin } from "@/lib/business/network";
import { visualFor } from "@/lib/business/art";
import { getTemplate } from "@/lib/business/templates";
import { paletteStyle, toneVars } from "@/lib/business/theme";
import s from "./shell.module.css";

export const dynamic = "force-dynamic";

/**
 * LE SÉLECTEUR D'ENTREPRISE, et la porte d'entrée du portail.
 *
 * Un seul commerce: on y va directement, sans faire cliquer sur une liste d'un élément. Plusieurs:
 * on choisit, chaque carte disant quel PERSONNAGE l'ouvre - un compte à plusieurs personnages voit
 * les commerces de chacun, et sans le nom la liste serait ambiguë.
 *
 * Aucun commerce: on l'explique. C'est un état parfaitement normal (on ne travaille nulle part, ou
 * son métier n'a pas le portail activé), et la page ne doit surtout pas ressembler à une panne.
 *
 * ⚠ CHOISIR UNE ENSEIGNE, PAS LIRE UNE LISTE. C'était une pile de liens texte: deux commerces s'y
 * distinguaient par un nom et rien d'autre, alors que la seule chose que le portail sait faire pour
 * les distinguer d'un coup d'oeil est déjà en base. Chaque carte porte donc les quatre canaux
 * d'identité de l'enseigne, tous des DONNÉES et aucun décoratif: la matière de sa plaque
 * (`--plate`), la teinte de son dessin de rayon (`--k`), la surface de sa carte (`--surf`) et son
 * accent (`--brand-text`). La silhouette est celle de la vignette de la Caisse (plaque, corps,
 * rangée d'action), parce qu'un portail qui change de langage entre sa porte d'entrée et sa
 * première page n'a l'air de rien.
 */

/** Le palier de présence, par commerce: il est PAR PERSONNAGE, donc il diffère d'une carte à l'autre. */
const PRESENCE: Record<BusinessAccess["tier"], { cls: string; txt: string }> = {
  session: { cls: "off", txt: "Hors ligne" },
  ingame: { cls: "warn", txt: "En jeu" },
  // ⚠ `on` et non `ok`: `business.css` ne définit que `.tag.on`, `.tag.warn`, `.tag.bad` et
  // `.tag.off`. Une classe `ok` existait ici et ne correspondait à aucune règle, donc le seul état
  // qu'on veut voir de loin, "En service", était le seul rendu sans couleur.
  service: { cls: "on", txt: "En service" },
};

export default async function BusinessIndex() {
  const identity = await requireIdentity();
  const [all, isNetwork] = await Promise.all([
    getBusinessAccess(identity),
    isNetworkAdmin(identity),
  ]);

  /**
   * ⚠ LE RACCOURCI NE S'APPLIQUE PAS À QUI ADMINISTRE LE RÉSEAU. Un compte à un seul commerce n'a
   * rien à choisir, donc on l'y envoie directement - mais un administrateur réseau a bel et bien un
   * second endroit où aller, et l'y renvoyer sans lui montrer la console lui retirerait la seule
   * page qu'il vient peut-être chercher. Il la retrouve de toute façon dans le rail de n'importe
   * quel commerce; ce serait simplement un détour absurde pour arriver au même endroit.
   */
  if (all.length === 1 && !isNetwork) redirect(`/business/${all[0]!.slug}/caisse`);

  return (
    <div className={`app ${s.portal}`} data-biz="none">
      {/* Une seule feuille pour toutes les enseignes visibles: chaque carte porte son `data-biz` et
          récupère ainsi SA palette, dans les deux thèmes. Même mécanisme que la coquille d'un
          commerce, pour la même raison: la palette est une donnée, pas une feuille de style. */}
      <style
        dangerouslySetInnerHTML={{
          __html: all.map((b) => paletteStyle(b.slug, b.palette)).join(""),
        }}
      />

      <div className="shell">
        <div className={`col ${s.col}`}>
          <main className="main">
            <div className="page">
              <div className={s.masthead}>
                <span className="li" title="It's not technology, it's your life!">
                  <b>Life</b>invader
                </span>
                <h1 className={s.mtitle}>Entreprises</h1>
                <span className={s.mspacer} />
                {/* ⚠ L'ENTRÉE VERS LA CONSOLE VIT AUSSI ICI, et pas seulement dans le rail d'un
                    commerce. Un administrateur réseau n'a pas forcément d'emploi (le Fondateur n'en
                    a aucun), et cette page est alors la SEULE qu'il voit: sans ce lien, la console
                    serait inatteignable pour exactement la personne à qui elle appartient. */}
                {isNetwork ? (
                  <Link href="/business/reseau" className={s.netlink}>
                    <Network size={14} strokeWidth={1.75} aria-hidden="true" />
                    Console réseau
                  </Link>
                ) : null}
                <span className="ver">v1.0.0 BETA</span>
              </div>

              {all.length === 0 ? (
                <div className={s.empty}>
                  <span className={s.emptymark}>
                    <Store size={22} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <div className={s.emptytitle}>Aucune entreprise</div>
                  <p className={s.emptytext}>
                    {isNetwork
                      ? "Vous n'êtes employé d'aucune entreprise. La console réseau, elle, reste ouverte : c'est de là qu'on ouvre un portail pour un métier."
                      : "Le portail s'ouvre pour le métier que vous exercez en jeu. Prenez un emploi, ou demandez à votre patron d'activer le portail pour le vôtre."}
                  </p>
                  {isNetwork ? (
                    <div className={s.emptyacts}>
                      <Link href="/business/reseau" className="btn">
                        Ouvrir la console réseau
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <p className={s.lead}>Choisissez une entreprise.</p>
                  <div className={s.cards}>
                    {all.map((b) => {
                      const pres = PRESENCE[b.tier];
                      const mark = visualFor(null, b.categories[0]?.icon);
                      const kind = getTemplate(b.template)?.label ?? null;
                      return (
                        <Link
                          key={b.slug}
                          href={`/business/${b.slug}/caisse`}
                          className={s.card}
                          data-biz={b.slug}
                          style={toneVars(b.categories[0]?.tone ?? 1) as React.CSSProperties}
                        >
                          <span
                            className={s.cmark}
                            aria-hidden="true"
                            // La chaîne vient d'une table figée du code (`CATEGORY_ICONS`), jamais
                            // de la base: la donnée stockée ne sert que de CLÉ de recherche, et une
                            // clé inconnue retombe sur `box`.
                            dangerouslySetInnerHTML={{ __html: mark.svg }}
                          />
                          <span className={s.cbody}>
                            {/* Le genre de commerce, pas son identifiant technique: un modèle sans
                                libellé connu n'affiche rien plutôt que son slug. */}
                            {kind ? <span className={s.ckicker}>{kind}</span> : null}
                            <span className={s.cname}>{b.name}</span>
                            <span className={s.cwho}>
                              <b>{b.employeeName}</b>, {b.gradeName}
                            </span>
                          </span>
                          <span className={s.cfoot}>
                            <span className={`tag ${pres.cls}`}>
                              <i />
                              {pres.txt}
                            </span>
                            <span className={s.copen}>
                              Ouvrir
                              <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                            </span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
