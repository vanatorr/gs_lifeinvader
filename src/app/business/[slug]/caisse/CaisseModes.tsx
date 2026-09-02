"use client";

import { useState, type ReactNode } from "react";

/**
 * LES DEUX VOLETS D'UNE CAISSE D'ATELIER: Customs et Boutique.
 *
 * Demande du proprietaire (2026-08-27): le garage vend aussi des articles au comptoir ("to sell
 * kit de reparation juste like a supperette would") et la concession facture aussi des customs.
 * Un commerce dont le modele pose `billsCustoms` recoit donc les DEUX caisses derriere la meme
 * route, et ce composant ne fait que choisir laquelle est visible.
 *
 * ⚠ LES DEUX VOLETS RESTENT MONTES, l'inactif est seulement masque (`hidden`). Le panier de la
 * boutique et le devis de customs vivent chacun dans l'etat local de leur volet: demonter le volet
 * inactif viderait le ticket de quelqu'un qui a juste voulu verifier un prix de l'autre cote, et
 * c'est exactement le genre de perte qu'on ne signale jamais.
 *
 * ⚠ L'ONGLET N'OUVRE AUCUN DROIT. Le volet par defaut vient du MODELE (`templateCaisseDefault`,
 * resolu serveur), mais basculer est libre: chaque action serveur derriere chaque volet re-verifie
 * son propre chemin (`declareSale` exige un catalogue et un modele vendeur de vehicules,
 * `declareCustomSale` exige `billsCustoms`). Cacher un volet n'est pas une serrure, et en montrer
 * un n'en est pas une non plus.
 */
export default function CaisseModes({
  initial,
  customs,
  boutique,
}: {
  initial: "customs" | "boutique";
  customs: ReactNode;
  boutique: ReactNode;
}) {
  const [mode, setMode] = useState<"customs" | "boutique">(initial);

  return (
    <div className="lc-modes-wrap">
      <div className="lc-modes" role="tablist" aria-label="Volet de caisse">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "customs"}
          className={mode === "customs" ? "lc-mode lc-mode-on" : "lc-mode"}
          onClick={() => setMode("customs")}
        >
          Customs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "boutique"}
          className={mode === "boutique" ? "lc-mode lc-mode-on" : "lc-mode"}
          onClick={() => setMode("boutique")}
        >
          Boutique
        </button>
      </div>
      <div hidden={mode !== "customs"}>{customs}</div>
      <div hidden={mode !== "boutique"}>{boutique}</div>
    </div>
  );
}
