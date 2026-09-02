/**
 * LE BAREME DE MARGE, ET LA COTATION D'UN CUSTOM. Le seul endroit ou le cout des pieces et la marge
 * du proprietaire se rencontrent.
 *
 * Regle du proprietaire (2026-08-23): *"the margin they should add for themselves on each custom
 * shouldnt be the same per car or per custom on a car. they should be defined by me and not
 * modifiable by them"*, puis *"i want a smart system that would work with all cars and smart math.
 * like it should also be coherant with their dealership client buy price"*.
 *
 * ── LE MODELE: UNE DROITE, ET LE MULTIPLICATEUR N'EST PAS UN REGLAGE ────────────────────────────
 *
 *     prix = cout x rate + labour
 *     m    = prix / cout = rate + labour / cout
 *
 * C'est la seconde ligne qui repond a la demande. Le forfait `labour` est fixe, donc il se DILUE
 * quand le chantier grossit: une peinture de Primo (89 $ de pieces) sort a x8, un moteur 4 sur la
 * meme Primo (6 842 $) sort a x1,2, et la peinture d'une Zentorno (4 312 $) sort a x1,25. Les trois
 * exemples que le proprietaire a donnes tombent de DEUX nombres, sans une seule ligne par voiture.
 *
 * ⚠ LE MULTIPLICATEUR NE SE STOCKE DONC JAMAIS, IL SE DEDUIT. Quelqu'un finira par vouloir "ranger"
 * un champ `multiplier` dans la table pour que l'ecran soit plus direct: ce serait re-introduire
 * exactement le probleme que le proprietaire decrit, un chiffre a saisir par voiture et par custom.
 *
 * ── LA COHERENCE AVEC LE PRIX CONCESSION EST STRUCTURELLE, PAS AJOUTEE ──────────────────────────
 *
 * Le cout des pieces vaut deja `pct x valeur_du_vehicule` (le jeu le calcule ainsi, voir
 * customPricing.ts), donc le prix final reste une fraction quasi constante du prix neuf sur toute la
 * gamme: un moteur 4 pese 95 a 102 % de la valeur du vehicule de la Primo (8 000 $) a la Zentorno
 * (385 000 $). Rien n'a besoin d'etre aligne a la main.
 *
 * ⚠ CE MODULE EST `server-only`, CONTRAIREMENT A `customPricing.ts`. Ce dernier ne lit qu'une config
 * publique; celui-ci porte les coefficients du proprietaire. Les expedier au navigateur ferait
 * calculer le prix par le client, donc rendrait un POST forge capable d'annoncer le sien: c'est
 * exactement la protection 1 de `declareSale` ("les prix viennent de la base") qu'on perdrait.
 */
import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelMarginRules } from "@/lib/db/schema/citadel";
import { vehicleByModel, type FleetVehicle } from "./fleet";
import {
  pickRule,
  applyMargin,
  scopeScore,
  type MarginRule,
} from "./customMarginMath";
import {
  customCatalog,
  findTier,
  partsCostCents,
  DISPLAY_GROUPS,
  type CustomGroupKey,
  type CustomSlot,
  type CustomTier,
} from "./customPricing";

/* -- Lecture du bareme ------------------------------------------------------------------------- */

export async function listRules(): Promise<MarginRule[]> {
  const rows = await db
    .select({
      id: citadelMarginRules.id,
      vehicleModel: citadelMarginRules.vehicleModel,
      vehicleCategory: citadelMarginRules.vehicleCategory,
      slotKey: citadelMarginRules.slotKey,
      slotLevel: citadelMarginRules.slotLevel,
      rateBps: citadelMarginRules.rateBps,
      labourCents: citadelMarginRules.labourCents,
      capBpsOfVehicle: citadelMarginRules.capBpsOfVehicle,
      note: citadelMarginRules.note,
    })
    .from(citadelMarginRules)
    .orderBy(asc(citadelMarginRules.id));
  return rows as MarginRule[];
}

/** La regle globale: celle dont les quatre axes sont NULL. Son absence bloque toute cotation. */
export async function globalRule(): Promise<MarginRule | null> {
  const rows = await db
    .select()
    .from(citadelMarginRules)
    .where(
      and(
        isNull(citadelMarginRules.vehicleModel),
        isNull(citadelMarginRules.vehicleCategory),
        isNull(citadelMarginRules.slotKey),
        isNull(citadelMarginRules.slotLevel),
      ),
    )
    .limit(1);
  return (rows[0] as MarginRule) ?? null;
}

/* -- Cotation ---------------------------------------------------------------------------------- */

export type QuotedTier = {
  slotKey: string;
  /** INDEX GTA du palier. Voir l'avertissement sur `CustomTier.level`. */
  level: number;
  /** Le libelle deterministe qui finira sur la ligne de vente: "moteur niveau 4". */
  label: string;
  category: "performance" | "esthetique";
  priceCents: number;
  /**
   * Le cout des pieces. `null` quand l'appelant n'a PAS demande a le voir.
   *
   * ⚠ OMIS PAR DEFAUT, ET C'EST UNE DECISION DU PROPRIETAIRE (2026-08-23): il a demande a ne pas
   * afficher la valeur du vehicule a l'employe. Or afficher cout ET prix cote a cote redonne la
   * marge par simple division, donc la valeur du vehicule par simple division encore. Masquer l'un
   * sans l'autre ne masquerait rien.
   */
  costCents: number | null;
  /** Renseigne quand le plafond a mordu, pour que l'ecran patron puisse le dire. */
  cappedBy: number | null;
};

export type QuotedGroup = { key: CustomGroupKey; label: string; tiers: QuotedTier[] };

export type CustomQuote =
  | { ok: true; vehicle: FleetVehicle; groups: QuotedGroup[] }
  | { ok: false; error: "unknown_model" | "no_catalog" | "no_global_rule" };

function tierLabel(slot: CustomSlot, tier: CustomTier): string {
  return tier.tierLabel ? `${slot.label} ${tier.tierLabel}` : slot.label;
}

/**
 * TOUTES LES PRESTATIONS CHIFFREES POUR UNE VOITURE, en un seul aller-retour.
 *
 * C'est ce que la caisse appelle quand l'employe a choisi le vehicule: *"prices automatically
 * display billing price"*. Le navigateur n'envoie qu'un `model` et ne recoit que des prix deja
 * calcules, jamais les coefficients.
 *
 * ⚠ REFUSE PLUTOT QUE DE SUPPOSER. Sans regle globale en base, on renvoie `no_global_rule` au lieu
 * de retomber sur une marge par defaut ecrite dans le code. Un garage qui ne peut plus rien
 * facturer est un incident visible en une minute; un garage qui facture une marge devinee ne se
 * voit jamais. Meme discipline que le refus `no_ceiling` de `declareFreeSale`.
 */
export async function quoteCustoms(
  model: string,
  opts: { withCost?: boolean } = {},
): Promise<CustomQuote> {
  const vehicle = vehicleByModel(model);
  if (!vehicle) return { ok: false, error: "unknown_model" };

  const cat = customCatalog();
  if (!cat.ok || cat.slots.length === 0) return { ok: false, error: "no_catalog" };

  const rules = await listRules();
  if (!rules.some((r) => scopeScore(r) === 0)) return { ok: false, error: "no_global_rule" };

  const valueCents = vehicle.priceDollars * 100;
  const byGroup = new Map<CustomGroupKey, QuotedTier[]>();

  for (const slot of cat.slots) {
    for (const tier of slot.tiers) {
      const rule = pickRule(rules, {
        model: vehicle.model,
        category: vehicle.category,
        slotKey: slot.key,
        level: tier.level,
      });
      if (!rule) continue; // impossible tant qu'une regle globale existe, verifiee juste au-dessus.
      const costCents = partsCostCents(vehicle.priceDollars, tier);
      const { priceCents, cappedBy } = applyMargin(costCents, rule, valueCents);
      const list = byGroup.get(slot.group) ?? [];
      list.push({
        slotKey: slot.key,
        level: tier.level,
        label: tierLabel(slot, tier),
        category: slot.category,
        priceCents,
        costCents: opts.withCost ? costCents : null,
        cappedBy,
      });
      byGroup.set(slot.group, list);
    }
  }

  const groups: QuotedGroup[] = DISPLAY_GROUPS.filter((g) => (byGroup.get(g.key)?.length ?? 0) > 0).map(
    (g) => ({ key: g.key, label: g.label, tiers: byGroup.get(g.key) ?? [] }),
  );

  return { ok: true, vehicle, groups };
}

/**
 * UNE SEULE PRESTATION, re-cotee au moment de la declaration.
 *
 * ⚠ LA CAISSE RE-COTE, ELLE NE FAIT PAS CONFIANCE A CE QU'ELLE A AFFICHE. Entre l'affichage et la
 * validation, le proprietaire a pu changer le bareme, et le navigateur a de toute facon pu envoyer
 * n'importe quoi. Le prix ecrit sur le ticket est celui que CETTE fonction calcule au moment du
 * commit, jamais celui qui a transite.
 */
export async function quoteOne(
  model: string,
  slotKey: string,
  level: number,
): Promise<
  | { ok: true; label: string; category: "performance" | "esthetique"; priceCents: number; costCents: number }
  | { ok: false; error: "unknown_model" | "unknown_custom" | "no_rule" }
> {
  const vehicle = vehicleByModel(model);
  if (!vehicle) return { ok: false, error: "unknown_model" };

  const found = findTier(slotKey, level);
  if (!found) return { ok: false, error: "unknown_custom" };

  const rules = await listRules();
  const rule = pickRule(rules, {
    model: vehicle.model,
    category: vehicle.category,
    slotKey,
    level,
  });
  if (!rule) return { ok: false, error: "no_rule" };

  const costCents = partsCostCents(vehicle.priceDollars, found.tier);
  const { priceCents } = applyMargin(costCents, rule, vehicle.priceDollars * 100);
  return {
    ok: true,
    label: tierLabel(found.slot, found.tier),
    category: found.slot.category,
    priceCents,
    costCents,
  };
}

/* -- Ecriture (Fondateur uniquement, gardee par CODES.BUSINESS_MARGIN cote action) -------------- */

export type RuleInput = {
  vehicleModel: string | null;
  vehicleCategory: string | null;
  slotKey: string | null;
  slotLevel: number | null;
  rateBps: number;
  labourCents: number;
  capBpsOfVehicle: number | null;
  note: string | null;
};

export type PutRuleResult =
  | { ok: true; id: number }
  | { ok: false; error: "bad_rate" | "bad_labour" | "bad_cap" | "duplicate_global" | "unknown_model" | "unknown_custom" };

/**
 * CREE OU MET A JOUR UNE REGLE.
 *
 * ⚠ LE DOUBLON DE LA REGLE GLOBALE EST ATTRAPE ICI ET NULLE PART AILLEURS. MySQL considere chaque
 * NULL comme distinct dans un index unique, donc `uq_margin_rules_scope` n'empeche PAS deux lignes
 * a quatre NULL. Deux regles globales rendraient le prix dependant de l'ordre de lecture, c'est-a-
 * dire instable d'un rendu a l'autre sans que rien n'echoue.
 *
 * ⚠ LA PORTEE EST VALIDEE CONTRE LES DONNEES REELLES: un modele qui n'est pas dans le roster ou un
 * slot qui n'est pas dans Config.Menus produit une regle qui ne s'appliquera jamais. Une regle
 * silencieusement inerte est pire qu'un refus, parce qu'on croit avoir fixe un prix.
 */
export async function putRule(input: RuleInput, actorAccountId: number): Promise<PutRuleResult> {
  if (!Number.isInteger(input.rateBps) || input.rateBps < 10_000 || input.rateBps > 1_000_000) {
    // Plancher a 10 000 bps (x1): en dessous, le garage vend la piece moins cher qu'il ne l'a payee.
    return { ok: false, error: "bad_rate" };
  }
  if (!Number.isInteger(input.labourCents) || input.labourCents < 0 || input.labourCents % 100 !== 0) {
    return { ok: false, error: "bad_labour" };
  }
  if (
    input.capBpsOfVehicle !== null &&
    (!Number.isInteger(input.capBpsOfVehicle) || input.capBpsOfVehicle <= 0)
  ) {
    return { ok: false, error: "bad_cap" };
  }
  if (input.vehicleModel !== null && !vehicleByModel(input.vehicleModel)) {
    return { ok: false, error: "unknown_model" };
  }
  if (input.slotKey !== null) {
    const slot = customCatalog().slots.find((s) => s.key === input.slotKey);
    if (!slot) return { ok: false, error: "unknown_custom" };
    if (input.slotLevel !== null && !slot.tiers.some((t) => t.level === input.slotLevel)) {
      return { ok: false, error: "unknown_custom" };
    }
  } else if (input.slotLevel !== null) {
    // Un palier sans slot ne designe rien: le niveau 3 "de quoi"?
    return { ok: false, error: "unknown_custom" };
  }

  const isGlobal =
    input.vehicleModel === null &&
    input.vehicleCategory === null &&
    input.slotKey === null &&
    input.slotLevel === null;

  if (isGlobal) {
    const existing = await globalRule();
    if (existing) {
      await db
        .update(citadelMarginRules)
        .set({
          rateBps: input.rateBps,
          labourCents: input.labourCents,
          capBpsOfVehicle: input.capBpsOfVehicle,
          note: input.note,
          updatedBy: actorAccountId,
        })
        .where(eq(citadelMarginRules.id, existing.id));
      return { ok: true, id: existing.id };
    }
  }

  const [res] = await db.insert(citadelMarginRules).values({
    vehicleModel: input.vehicleModel,
    vehicleCategory: input.vehicleCategory,
    slotKey: input.slotKey,
    slotLevel: input.slotLevel,
    rateBps: input.rateBps,
    labourCents: input.labourCents,
    capBpsOfVehicle: input.capBpsOfVehicle,
    note: input.note,
    updatedBy: actorAccountId,
  });
  return { ok: true, id: Number((res as { insertId: number }).insertId) };
}

/**
 * SUPPRIME UNE EXCEPTION.
 *
 * ⚠ LA REGLE GLOBALE NE SE SUPPRIME PAS. Sans elle, plus aucun garage ne peut coter quoi que ce
 * soit: le refus est ici plutot que dans l'ecran, parce qu'une Server Action est un POST public et
 * que cacher le bouton n'est pas une serrure.
 */
export async function deleteRule(id: number): Promise<{ ok: boolean; error?: "is_global" }> {
  const g = await globalRule();
  if (g && g.id === id) return { ok: false, error: "is_global" };
  await db.delete(citadelMarginRules).where(eq(citadelMarginRules.id, id));
  return { ok: true };
}

export { pickRule, applyMargin, type MarginRule } from "./customMarginMath";
