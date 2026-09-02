import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { requireIdentity } from "@/lib/auth/session";
import {
  businessCan,
  getBusinessAccess,
  getBusinessAsNetworkAdmin,
  type BusinessAccess,
} from "@/lib/business/access";
import { isNetworkAdmin } from "@/lib/business/network";
import { visualFor } from "@/lib/business/art";
import { CAP, type Capability } from "@/lib/business/capabilities";
import { moduleOfCapability } from "@/lib/business/modules";
import { getTemplate, templateGrid } from "@/lib/business/templates";
import { paletteStyle, toneVars } from "@/lib/business/theme";
import PresenceWatch from "./PresenceWatch";
import ShellNav, { type NavItem } from "./ShellNav";
import s from "../shell.module.css";

export const dynamic = "force-dynamic";

/**
 * LA COQUILLE D'UN COMMERCE: rail de navigation, palette, état de présence.
 *
 * ⚠ CETTE MISE EN PAGE N'EST PAS UNE FRONTIÈRE DE SÉCURITÉ, malgré le `notFound()` ci-dessous. Next
 * peut rendre une page sans sa mise en page parente lors d'une navigation côté client, et un Server
 * Action est un POST public à l'URL de la page. Chaque page et chaque action re-résout donc son
 * accès. Le contrôle ici sert à ne pas dessiner un cadre autour de rien.
 *
 * `notFound()` et non une page "interdit": distinguer "ce commerce n'existe pas" de "vous n'y
 * travaillez pas" confirmerait l'existence d'une enseigne à qui essaie des slugs.
 */

/**
 * POURQUOI une capacité est refusée, en une formule que la personne peut suivre.
 *
 * ⚠ NE PAS DEVINER LA CAUSE. `businessCan` échoue pour TROIS raisons distinctes, et la version
 * précédente affirmait toujours la troisième. Un employé dont le grade n'a jamais reçu
 * `sale.declare` lisait donc "prise de service requise", prenait son service, et rien ne changeait:
 * aucun écran ne lui disait jamais que la cause était son grade, ni à qui la demander. Une impasse
 * complète, produite par un message qui avait l'air utile.
 */
function whyBlocked(a: BusinessAccess, cap: Capability, moduleLabel: string): string {
  const mod = moduleOfCapability(cap);
  if (mod && a.modules[mod] === false) return `${moduleLabel} désactivé pour ce commerce`;
  if (!a.capabilities.has(cap)) return "votre grade n'y a pas droit, demandez-le à la direction";
  return "prise de service requise";
}

/**
 * Ce que le rail propose, et POURQUOI une entrée peut être présente mais barrée.
 *
 * Deux groupes, et la coupure est celle du métier plutôt que celle des permissions: `poste` est ce
 * qu'on fait de ses mains pendant un service, `gestion` est ce qu'on décide pour les autres. Un
 * employé sans droits de gestion n'a donc qu'un seul groupe, et son titre disparaît avec lui.
 */
function navFor(a: BusinessAccess, isNetwork: boolean): NavItem[] {
  const out: NavItem[] = [];
  const base = `/business/${a.slug}`;

  if (a.modules.caisse !== false) {
    out.push({
      href: `${base}/caisse`,
      label: "Caisse",
      ok: businessCan(a, CAP.SALE_DECLARE),
      why: whyBlocked(a, CAP.SALE_DECLARE, "Caisse"),
      icon: "caisse",
      group: "poste",
    });
  }
  out.push({
    href: `${base}/mes-ventes`,
    label: "Mes ventes",
    ok: businessCan(a, CAP.SALE_READ_SELF),
    why: whyBlocked(a, CAP.SALE_READ_SELF, "Mes ventes"),
    icon: "ventes",
    group: "poste",
  });

  if (a.modules.equipe !== false && a.capabilities.has(CAP.TEAM_READ)) {
    out.push({
      href: `${base}/gestion/equipe`,
      label: "Équipe",
      ok: businessCan(a, CAP.TEAM_READ),
      why: "connexion au jeu requise",
      icon: "equipe",
      group: "gestion",
    });
  }
  /**
   * ⚠ ANALYTIQUE EST GARDÉE PAR `team.read`, EXACTEMENT COMME ÉQUIPE, ET SUIT DONC LE MÊME MODULE.
   * Ce n'est pas un raccourci de navigation: la page montre le chiffre par vendeur et le rendement
   * de chacun, donc elle répond à la même question de droit ("qui peut voir les chiffres des
   * autres") et n'a aucune raison d'avoir sa propre porte. Voir l'entête de gestion/analytique/page.tsx.
   * La condition de visibilité est copiée telle quelle sur celle d'Équipe juste au-dessus, pour que
   * les deux entrées apparaissent et disparaissent ensemble plutôt que de laisser croire à un droit
   * séparé que personne ne peut accorder.
   */
  if (a.modules.equipe !== false && a.capabilities.has(CAP.TEAM_READ)) {
    out.push({
      href: `${base}/gestion/analytique`,
      label: "Analytique",
      ok: businessCan(a, CAP.TEAM_READ),
      why: "connexion au jeu requise",
      icon: "analytique",
      group: "gestion",
    });
  }
  if (a.modules.pointage !== false && a.capabilities.has(CAP.SHIFT_READ)) {
    out.push({
      href: `${base}/gestion/pointage`,
      label: "Pointage",
      ok: businessCan(a, CAP.SHIFT_READ),
      why: "connexion au jeu requise",
      icon: "pointage",
      group: "gestion",
    });
  }
  if (a.modules.catalogue !== false && a.capabilities.has(CAP.CATALOGUE_WRITE)) {
    // ⚠ Un commerce en grille numérotée ne tient pas un CATALOGUE d'articles, il affiche des TARIFS,
    // et c'est le mot qui figure sur l'écran derrière ce lien. Une entrée de menu qui ne nomme pas la
    // page qu'elle ouvre est une petite trahison qui se paie en clics perdus.
    const grid = templateGrid(a.template) !== null;
    out.push({
      href: `${base}/gestion/catalogue`,
      label: grid ? "Tarifs" : "Catalogue",
      ok: businessCan(a, CAP.CATALOGUE_WRITE),
      why: whyBlocked(a, CAP.CATALOGUE_WRITE, grid ? "Tarifs" : "Catalogue"),
      icon: "catalogue",
      group: "gestion",
    });
  }
  if (a.capabilities.has(CAP.SETTINGS_WRITE)) {
    out.push({
      href: `${base}/gestion/reglages`,
      label: "Réglages",
      // `whyBlocked` plutôt que la phrase en dur qui était ici: `settings.write` n'appartient
      // aujourd'hui à aucun module, donc les deux disent la même chose, mais le jour où un module
      // le porterait, la phrase en dur mentirait sur la cause. Voir le commentaire de `whyBlocked`.
      ok: businessCan(a, CAP.SETTINGS_WRITE),
      why: whyBlocked(a, CAP.SETTINGS_WRITE, "Réglages"),
      icon: "reglages",
      group: "gestion",
    });
  }

  /**
   * LA CONSOLE RÉSEAU, pour qui administre le portail lui-même.
   *
   * ⚠ ELLE NE DÉPEND D'AUCUNE CAPACITÉ DU COMMERCE OUVERT, et c'est pour ça qu'elle ne passe pas par
   * `businessCan`: on peut administrer le réseau sans avoir le moindre droit dans l'enseigne qu'on
   * est en train de regarder. `navFor` reçoit donc le verdict déjà rendu par la page, plutôt que de
   * le recalculer à partir d'un accès qui ne le porte pas.
   *
   * L'entrée est ABSENTE, pas barrée, pour qui n'y a pas droit: une entrée barrée explique un refus
   * à quelqu'un qui pourrait y remédier (prendre son service, demander un droit à sa direction).
   * Ici il n'y a rien à demander, et nommer la console à toute une équipe ne lui apprend rien
   * d'utile.
   */
  if (isNetwork) {
    out.push({
      href: "/business/reseau",
      label: "Console réseau",
      ok: true,
      why: "",
      icon: "reseau",
      group: "reseau",
    });
  }

  return out;
}

/**
 * LE PALIER DE PRÉSENCE, ET SA CONSÉQUENCE, parce que la pastille seule ne se suffit pas.
 *
 * Tout droit d'ÉCRITURE du portail passe par ce palier (`CAP_TIER`): sans la phrase, quelqu'un lit
 * "En jeu", trouve la Caisse barrée, et n'a aucun moyen de relier les deux. La phrase parle du
 * palier et de rien d'autre: un refus dû au grade est nommé sur l'entrée elle-même.
 */
const PRESENCE: Record<BusinessAccess["tier"], { cls: string; txt: string; hint: string }> = {
  session: { cls: s.presOff, txt: "Hors ligne", hint: "Vos ventes et vos heures seulement." },
  ingame: { cls: s.presWarn, txt: "En jeu", hint: "Prenez votre service pour écrire." },
  service: { cls: s.presOn, txt: "En service", hint: "Vous pouvez écrire." },
};

/**
 * L'ÉTAT D'UN ACCÈS RÉSEAU, qui n'est PAS un palier de présence.
 *
 * ⚠ On ne réutilise aucune des trois pastilles ci-dessus, et surtout pas "En service": la personne
 * n'a pris aucun service, et l'afficher serait une présence inventée sur la seule ligne du portail
 * qui prétend décrire une présence réelle. Elle ne peut pas non plus lire "Hors ligne - vos ventes
 * et vos heures seulement", qui serait faux dans l'autre sens puisqu'elle peut tout écrire ici. Un
 * quatrième état, dit pour ce qu'il est.
 */
const NETWORK_PRESENCE = {
  cls: s.presWarn,
  txt: "Accès réseau",
  hint: "Vous n'êtes pas employé ici.",
};

export default async function BusinessShell({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();

  /**
   * ⚠ MÊME PORTE QU'AVANT, littéralement: `getBusinessBySlug` est exactement
   * `getBusinessAccess(identity).find(b => b.slug === slug)`. On appelle le résolveur directement
   * pour obtenir EN PLUS le nombre de commerces, sans une seconde résolution complète (qui
   * relancerait quatre requêtes à chaque rendu de page). Ce nombre ne décide d'aucun droit: il
   * décide seulement si le bloc d'enseigne est un lien vers le sélecteur, parce qu'un compte à un
   * seul commerce n'a rien à choisir et qu'un lien qui renvoie sur place est une fausse promesse.
   */
  const all = await getBusinessAccess(identity);
  /**
   * L'APPARTENANCE D'ABORD, l'accès réseau seulement en dernier recours.
   *
   * ⚠ On n'appelle PAS `getBusinessBySlug` ici, qui relancerait `getBusinessAccess` en entier alors
   * qu'on vient de le faire pour compter les commerces. Le repli réseau est appelé nommément, et
   * seulement quand l'appartenance n'a rien donné - c'est-à-dire jamais pour un employé ordinaire.
   */
  const access = all.find((b) => b.slug === slug) ?? (await getBusinessAsNetworkAdmin(identity, slug));
  if (!access) notFound();

  // Le droit d'administrer le RÉSEAU ne se déduit pas de l'accès au commerce ouvert: un
  // administrateur peut très bien être ici en simple employé (c'est même le cas sur sa propre
  // enseigne), et un accès réseau sur un commerce étranger n'est qu'une des deux façons d'y entrer.
  const isNetwork = access.networkAdmin || (await isNetworkAdmin(identity));

  const nav = navFor(access, isNetwork);
  const pres = access.networkAdmin ? NETWORK_PRESENCE : PRESENCE[access.tier];
  const mark = visualFor(null, access.categories[0]?.icon);
  const tone = toneVars(access.categories[0]?.tone ?? 1) as React.CSSProperties;
  const kind = getTemplate(access.template)?.label ?? null;
  const canSwitch = all.length > 1;

  /** L'enseigne: sa plaque, son nom, son genre de commerce. Identique à la carte du sélecteur. */
  const bizInner = (
    <>
      <span
        className={s.bizmark}
        style={tone}
        aria-hidden="true"
        // La chaîne vient d'une table figée du code (`CATEGORY_ICONS`), jamais de la base: la
        // donnée stockée ne sert que de CLÉ de recherche et une clé inconnue retombe sur `box`.
        dangerouslySetInnerHTML={{ __html: mark.svg }}
      />
      <span className={s.biztxt}>
        <span className={s.bizname}>{access.name}</span>
        {kind ? <span className={s.biztpl}>{kind}</span> : null}
      </span>
      {canSwitch ? (
        <ChevronsUpDown className={s.bizswap} size={14} strokeWidth={1.75} aria-hidden="true" />
      ) : null}
    </>
  );

  return (
    <div className="app" data-biz={access.slug}>
      {/* La palette est une DONNÉE, donc elle est servie ici plutôt que codée en dur dans la
          feuille de style. Un bloc <style> et pas un style en ligne: le thème clair a besoin
          d'une media query, qu'un attribut ne peut pas porter. */}
      <style dangerouslySetInnerHTML={{ __html: paletteStyle(access.slug, access.palette) }} />

      {/* Le palier est mesuré côté serveur au rendu, et deux tables que seul le JEU écrit le font
          changer: sans ceci, prendre son service en jeu ne se voyait qu'au rechargement suivant.
          Ne dessine rien, ne décide rien, redemande seulement le rendu quand la mesure a bougé. */}
      <PresenceWatch slug={access.slug} tier={access.tier} identifier={access.identifier} />

      <div className="shell">
        <aside className={s.rail}>
          <div className="brandbar">
            <span className="li" title="It's not technology, it's your life!">
              <b>Life</b>invader
            </span>
            <span className="ver">v1.0.0 BETA</span>
          </div>

          {canSwitch ? (
            <Link href="/business" className={s.biz} title="Changer d'entreprise">
              {bizInner}
            </Link>
          ) : (
            <div className={s.biz}>{bizInner}</div>
          )}

          <ShellNav items={nav} />

          <div className={s.who}>
            <div>
              <div className={s.whoname}>{access.employeeName}</div>
              <div className={s.whorole}>{access.gradeName}</div>
            </div>
            <div className={`${s.pres} ${pres.cls}`}>
              <i className={s.presdot} aria-hidden="true" />
              <span className={s.preslabel}>
                {pres.txt}
                <span className={s.preshint}>{pres.hint}</span>
              </span>
            </div>
          </div>
        </aside>

        <div className={`col ${s.col}`}>
          <main className="main">
            {/* ⚠ `.page` borne la largeur à 1360px et centre. La maquette enveloppe CHAQUE vue
                dedans; l'oublier ici ne se voyait pas sur la Caisse, qui se centre toute seule via
                sa propre grille, mais laissait toutes les pages de gestion s'étirer d'un bord à
                l'autre d'un écran large. Le genre d'écart qu'on ne voit pas sur la page qu'on
                vient d'écrire, seulement sur la suivante. */}
            <div className="page">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
