import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { listItems } from "@/lib/business/catalogue";
import { vehiclesForJob, type FleetVehicle } from "@/lib/business/fleet";
import {
  templateBillsCustoms,
  templateCaisseDefault,
  templateClientRecord,
  templateGrid,
  templateSellsVehicles,
} from "@/lib/business/templates";
import { clientRecordBounds } from "@/lib/business/clientRecordRules";
import CaisseView from "./CaisseView";
import CaisseGrilleView from "./CaisseGrilleView";
import CaisseCustomsView from "./CaisseCustomsView";
import CaisseModes from "./CaisseModes";

export const dynamic = "force-dynamic";

/**
 * LA CAISSE.
 *
 * ⚠ LA VENTE EST DÉCLARÉE, PAS ENCAISSÉE. Le portail additionne, l'employé établit la facture EN JEU
 * pour ce montant exact. Rien ici ne déplace d'argent, et la copie du ticket le dit noir sur blanc:
 * sans cette phrase, un total affiché en gros ressemble à un paiement.
 *
 * ⚠⚠ TROIS CAISSES DERRIÈRE UNE SEULE ROUTE, choisies par le MODÈLE du commerce et jamais par le
 * navigateur. Le cas ordinaire choisit des ARTICLES et le serveur va chercher leurs prix en base. Un
 * commerce en grille (le salon de tatouage) fait l'inverse: l'employé TAPE le prix de chaque pièce,
 * parce qu'elle se négocie devant le client et qu'aucun catalogue ne peut la décrire à l'avance.
 * C'est la seule situation du portail où le navigateur fixe un montant, et ce qui remplace le
 * prix-en-base est un plafond par ligne réglé par la direction et appliqué serveur. La troisième
 * (customs) CALCULE le prix côté serveur; depuis le 2026-08-27 elle s'AJOUTE à la caisse ordinaire
 * en second volet (garage, concession) au lieu de la remplacer, voir le commentaire plus bas.
 *
 * La page re-résout son accès elle-même - une mise en page n'est pas une frontière.
 */
export default async function CaissePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canDeclare = businessCan(access, CAP.SALE_DECLARE);
  const grid = templateGrid(access.template);

  if (grid) {
    return (
      <CaisseGrilleView
        slug={access.slug}
        name={access.name}
        slots={grid.slots}
        labelPrefix={grid.labelPrefix}
        canDeclare={canDeclare}
        // Le seul refus possible ici est le palier: `sale.declare` est dans le repli jour-un, donc
        // tout employé le détient tant que la direction ne l'a pas retiré. Si elle l'a fait, la
        // phrase reste vraie pour l'autre moitié des gens - elle ne prétend pas savoir laquelle.
        gateReason={
          canDeclare
            ? null
            : "Prenez votre service en jeu, ou demandez ce droit à la direction."
        }
        showCommission={access.modules.commissions !== false}
        commission={access.commission}
        lineMaxCents={access.lineMaxCents}
        // La vignette vient du MODELE, pas de la ligne du commerce: les vingt cases sont la meme
        // prestation, donc c'est une propriete du genre de commerce, pas du rayon que le patron
        // peut renommer.
        art={grid.art}
        icon={grid.icon}
        showVisuals={access.modules.visuels !== false}
      />
    );
  }

  // `catalogue.read` est au palier SESSION: la carte des prix n'est pas un secret, et un employé
  // hors ligne peut la consulter. Ce qu'il ne peut pas faire, c'est déclarer.
  const canRead = businessCan(access, CAP.CATALOGUE_READ);
  const items = canRead ? await listItems(access.businessId) : [];
  const vehicles: FleetVehicle[] = templateSellsVehicles(access.template)
    ? vehiclesForJob(access.job)
    : [];

  const boutique = (
    <CaisseView
      slug={access.slug}
      name={access.name}
      items={items}
      vehicles={vehicles}
      categories={access.categories}
      canDeclare={canDeclare}
      showCommission={access.modules.commissions !== false}
      /**
       * ⚠⚠ LE TAUX DE CETTE PERSONNE-CI, ET IL DOIT DESCENDRE JUSQU'À L'ÉCRAN. `access.commission`
       * est déjà résolu pour ce personnage (voir access.ts). Sans lui, la caisse continuerait
       * d'additionner `items.commission_cents`, c'est-à-dire ZÉRO dans un commerce payé au
       * pourcentage, et afficherait donc "aucune part" à quelqu'un que le serveur s'apprête à
       * créditer de la moitié de la facture. Un aperçu qui contredit ce qui est enregistré est pire
       * que pas d'aperçu: on cesse de le lire, puis on cesse de le croire.
       *
       * Le taux d'UNE personne, jamais la table des accords: la caisse n'a aucune raison de dire à
       * chaque employé ce que touchent ses collègues.
       */
      commission={access.commission}
      showVisuals={access.modules.visuels !== false}
      /**
       * ⚠ LE MODE VIENT DU MODÈLE, RÉSOLU ICI, ET LA CAISSE NE FAIT QUE L'AFFICHER. Descendre le
       * mode plutôt qu'un booléen "obligatoire" est ce qui permet à la concession de n'exiger la
       * fiche que lorsqu'une voiture est au panier: l'écran ne peut pas connaître cette règle
       * avant de savoir ce que l'employé a mis dedans, mais il ne doit pas non plus l'inventer.
       * `declareSale` refait exactement le même calcul, à partir de la même fonction partagée.
       */
      clientRecordMode={templateClientRecord(access.template)}
      /**
       * Les bornes d'une identité, lues dans les fichiers du jeu (gs_identity / gcphone). Elles
       * descendent jusqu'à l'écran pour que le message sous un champ dise le vrai intervalle
       * d'années plutôt qu'un nombre écrit en dur dans du JSX. Voir clientRecordRules.ts.
       */
      clientBounds={clientRecordBounds()}
    />
  );

  /**
   * ⚠ TROISIEME CAISSE, choisie par le MODELE et jamais par le navigateur, comme la grille: la
   * facturation de customs, dont le prix se CALCULE (cout reel des pieces x un bareme que le
   * commerce ne peut pas changer). Voir lib/business/customMargin.ts.
   *
   * ⚠⚠ DEPUIS LE 2026-08-27 ELLE NE REMPLACE PLUS LA BOUTIQUE, ELLE S'Y AJOUTE. Demande du
   * proprietaire: le garage vend aussi des articles au comptoir ("to sell kit de reparation juste
   * like a supperette would") et la concession facture aussi des customs. Un modele `billsCustoms`
   * recoit donc les DEUX volets derriere cette route (CaisseModes), et le volet d'arrivee vient du
   * modele (`templateCaisseDefault`): Customs au garage, Boutique a la concession. Un catalogue
   * vide n'enleve rien: le volet Boutique le dit et le volet Customs travaille comme avant.
   *
   * Grille et customs restent EXCLUSIFS (un modele qui declarerait les deux est une erreur de
   * configuration; la grille gagne ci-dessus et l'erreur se voit tout de suite).
   */
  if (templateBillsCustoms(access.template)) {
    return (
      <CaisseModes
        initial={templateCaisseDefault(access.template)}
        customs={
          <CaisseCustomsView
            slug={access.slug}
            name={access.name}
            canDeclare={canDeclare}
            gateReason={
              canDeclare ? null : "Prenez votre service en jeu, ou demandez ce droit a la direction."
            }
            showCommission={access.modules.commissions !== false}
            clientBounds={clientRecordBounds()}
          />
        }
        boutique={boutique}
      />
    );
  }

  return boutique;
}
