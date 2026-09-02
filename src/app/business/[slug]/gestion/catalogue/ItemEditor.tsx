"use client";

import { money, toneVars } from "@/lib/business/theme";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import ArtPicker from "./ArtPicker";
import { ProductTile } from "./ProductTile";
import { artSuggestion, previewCents, type Draft } from "./draft";
import s from "./catalogue.module.css";

type Category = { key: string; label: string; tone: number; icon?: string };

/**
 * LA FICHE D'UN ARTICLE: un seul à la fois, avec sa vignette qui se redessine à chaque frappe.
 *
 * ⚠ L'APERÇU EST EN HAUT, PAS EN BAS, ET C'EST LA MOITIÉ DU CORRECTIF. Le reproche du propriétaire
 * ("its ui is ass, not user friendly") portait sur un formulaire qui demandait un prix et une clé de
 * visuel sans jamais montrer le résultat: on éditait à l'aveugle une carte qu'on ne pouvait relire
 * qu'en changeant de page. La même vignette que la caisse, posée au-dessus des champs, met le prix et
 * le dessin dans le même regard, ce qui est précisément ce qu'on essaie de régler quand on tient une
 * carte.
 *
 * ⚠ LA FICHE EST DÉCOUPÉE EN TROIS MOMENTS NUMÉROTÉS, pas en une pile de champs. C'est la réponse
 * directe au "it too like liney line per line": une colonne de six champs de même poids ne dit pas
 * dans quel ordre les remplir, ni lesquels vont ensemble. Ce qu'on écrit, ce qu'on facture, comment
 * ça se dessine: trois questions, trois blocs, séparés par un filet (un SÉPARATEUR, pas un cadre).
 *
 * ⚠ LES DEUX MONTANTS SONT NOMMÉS, JAMAIS "PRIX" ET "COMMISSION". Le PRIX CLIENT est ce que la
 * personne paie. La PART EMPLOYÉ est versée par l'EMPLOYEUR en fin de semaine et ne sort jamais de la
 * facture. Une part SUPÉRIEURE au prix est légale et n'est bloquée ni ici ni côté serveur
 * (`lib/business/catalogue.ts` `validateItem` ne refuse que le négatif): la traiter comme une erreur
 * supposerait que c'est une remise, ce qui est l'inversion exacte que le propriétaire a corrigée.
 */
export default function ItemEditor({
  mode,
  draft,
  onChange,
  categories,
  showCommission,
  showVisuals,
  canWrite,
  writeReason,
  pending,
  dirty,
  error,
  archived,
  canMoveUp,
  canMoveDown,
  onSave,
  onCancel,
  onToggleActive,
  onMove,
}: {
  mode: "add" | "edit";
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  categories: Category[];
  showCommission: boolean;
  showVisuals: boolean;
  canWrite: boolean;
  /** Pourquoi l'écriture est fermée. Un bouton grisé sans motif se lit comme une panne. */
  writeReason: string | null;
  pending: boolean;
  dirty: boolean;
  error: string | null;
  archived: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSave: () => void;
  onCancel: () => void;
  onToggleActive: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const cat = categories.find((c) => c.key === draft.category);
  const tone = cat?.tone ?? 1;
  const locked = !canWrite || pending;

  const suggestion = artSuggestion(draft.label);
  const priceCents = previewCents(draft.price);
  const shareCents = showCommission ? previewCents(draft.commission) : 0;

  return (
    <Card className={cn(s.edPanel, "gap-0 overflow-hidden rounded-[var(--r)] py-0")}>
      <div className="ph">
        <span className="cap">{mode === "add" ? "Nouvel article" : "Modifier l'article"}</span>
        {dirty ? (
          <Badge variant="outline" className="border-[var(--warn)] text-[var(--warn)]">
            Non enregistré
          </Badge>
        ) : null}
      </div>

      <div className="edbody">
        {/* CE QUE LE CLIENT VERRA. La phrase est courte et au-dessus: sans elle, un patron peut
            croire que cette vignette est un gadget de la page de gestion. */}
        <div className="edprev">
          {/* Pas de classe `dim` ici: elle est declaree APRES `.cap` dans la feuille et lui
              reprendrait sa taille de 10px. `.edprev .cap` porte deja la couleur attenuee. */}
          <span className="cap">Ce que le client voit à la caisse</span>
          <ProductTile
            label={draft.label}
            priceCents={priceCents}
            commissionCents={shareCents}
            categoryLabel={cat?.label ?? draft.category ?? "Rayon"}
            tone={tone}
            artKey={draft.artKey}
            categoryIcon={cat?.icon}
            showVisual={showVisuals}
            showCommission={showCommission}
            archived={archived}
          />
        </div>

        {/* ── 1. Ce qu'on écrit sur la carte ─────────────────────────────────────────────────── */}
        <div className={s.edstep}>
          <div className={s.edstepHead}>
            <span className={`cap ${s.n}`}>1</span>
            <span className="cap">Ce qui est écrit sur la carte</span>
          </div>

          <label className="fld">
            <span>Nom de l&apos;article</span>
            <input
              className="search"
              value={draft.label}
              maxLength={120}
              disabled={locked}
              placeholder="Bière pression"
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </label>

          {/* Le rayon en PUCES et non en liste déroulante: ce sont les mêmes puces que la barre de
              filtres de la caisse, chacune à la couleur de son rayon, donc on choisit une couleur
              qu'on vient de voir plutôt qu'un mot dans un menu fermé. */}
          <div className="fld">
            <span>
              Rayon
              <em>Il décide de la couleur de la vignette et du groupe où l&apos;article se range.</em>
            </span>
            {categories.length === 0 ? (
              <em className="dim">
                Ce commerce n&apos;a aucun rayon déclaré. Créez-en un depuis les Réglages, sinon
                l&apos;article n&apos;apparaîtra dans aucun groupe de la caisse.
              </em>
            ) : (
              <div className="cats">
                {categories.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className="chip"
                    aria-pressed={draft.category === c.key}
                    disabled={locked}
                    style={toneVars(c.tone) as React.CSSProperties}
                    onClick={() => onChange({ category: c.key })}
                  >
                    <i />
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── 2. Les deux montants ───────────────────────────────────────────────────────────── */}
        <div className={s.edstep}>
          <div className={s.edstepHead}>
            <span className={`cap ${s.n}`}>2</span>
            <span className="cap">{showCommission ? "Le prix, et la part employé" : "Le prix"}</span>
          </div>

          <div className="fldrow">
            <label className="fld">
              <span>Prix client ($)</span>
              <input
                className="search num"
                type="number"
                min={0}
                step={1}
                value={draft.price}
                disabled={locked}
                onChange={(e) => onChange({ price: e.target.value })}
              />
              <em>Ce que la personne paie, et le seul montant qui entre dans sa facture.</em>
            </label>
            {showCommission ? (
              <label className="fld">
                <span>Part employé ($)</span>
                <input
                  className="search num"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.commission}
                  disabled={locked}
                  onChange={(e) => onChange({ commission: e.target.value })}
                />
                <em>Versée EN PLUS par la société, en fin de semaine.</em>
              </label>
            ) : null}
          </div>

          {/* La phrase compte les deux montants À VOIX HAUTE, avec les vrais chiffres de la fiche.
              Une note générique sous un formulaire se saute; une addition qui nomme les deux poches
              ne se saute pas, et c'est exactement le malentendu (part employé lue comme une remise)
              que le propriétaire a déjà eu à corriger une fois. */}
          {showCommission ? (
            <p className="foot edfoot">
              Le client paie <strong>{money(priceCents)}</strong>. La société verse en plus{" "}
              <strong>{money(shareCents)}</strong> à l&apos;employé. Rien n&apos;est déduit du prix
              client, donc la part peut dépasser le prix sans que ce soit une erreur.
            </p>
          ) : null}
        </div>

        {/* ── 3. Le dessin ───────────────────────────────────────────────────────────────────── */}
        <div className={s.edstep}>
          <div className={s.edstepHead}>
            <span className={`cap ${s.n}`}>3</span>
            <span className="cap">Le dessin</span>
          </div>

          {!showVisuals ? (
            <div className="note">
              <strong>Visuels produits désactivé.</strong> La caisse de ce commerce affiche des
              vignettes sans dessin. Le choix ci-dessous reste enregistré et réapparaîtra dès que le
              module sera rallumé depuis les Réglages.
            </div>
          ) : null}

          <ArtPicker
            value={draft.artKey}
            onChange={(artKey) => onChange({ artKey, artTouched: true })}
            categoryIcon={cat?.icon}
            tone={tone}
            disabled={locked}
            suggestion={suggestion}
            suggestionApplied={!draft.artTouched}
          />
        </div>

        {error ? <span className="gate">{error}</span> : null}
        {!canWrite && writeReason ? <span className="gate">{writeReason}</span> : null}

        <div className="edacts">
          <button className="btn" disabled={locked} onClick={onSave}>
            {pending ? "Enregistrement…" : mode === "add" ? "Créer l'article" : "Enregistrer"}
          </button>
          <button className="btn ghost" disabled={pending} onClick={onCancel}>
            {mode === "add" ? "Abandonner" : "Fermer"}
          </button>
        </div>

        {mode === "edit" ? (
          <div className="edmore">
            {/* Archiver et réactiver sont le MÊME bouton, parce que c'est la même bascule côté
                données (`setItemActive`). Rien n'est jamais supprimé: les ventes déjà déclarées
                pointent cet article. */}
            <button className="chip" disabled={locked} onClick={onToggleActive}>
              {archived ? "Remettre en vente" : "Archiver"}
            </button>
            {!archived ? (
              <>
                <button
                  className="chip"
                  disabled={locked || !canMoveUp}
                  onClick={() => onMove("up")}
                  aria-label="Placer plus tôt dans son rayon"
                  title="Placer plus tôt dans son rayon"
                >
                  Avancer
                </button>
                <button
                  className="chip"
                  disabled={locked || !canMoveDown}
                  onClick={() => onMove("down")}
                  aria-label="Placer plus tard dans son rayon"
                  title="Placer plus tard dans son rayon"
                >
                  Reculer
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
