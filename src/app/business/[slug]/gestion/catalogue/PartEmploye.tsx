"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgePercent, Coins, Lock, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  MAX_COMMISSION_BPS,
  bpsToPercent,
  formatRate,
  percentToBps,
  type CommissionMode,
  type CommissionPolicy,
} from "@/lib/business/commission";
import { money } from "@/lib/business/theme";
import { setCommissionAction } from "./actions";

export type PartEmployeMember = {
  identifier: string;
  name: string;
  gradeLabel: string;
};

/**
 * QUI TOUCHE QUOI: le seul écran qui règle la part employé.
 *
 * ⚠ IL VIT SUR LA PAGE CATALOGUE ET NON DANS LES RÉGLAGES, à dessein. La part est une décision de
 * PRIX ("sur cette facture, combien revient à l'artiste"), elle se prend en regardant les tarifs, et
 * elle est derrière la même capacité que ceux-ci (`catalogue.write`, dont la description dit déjà
 * "décide de ce que les gens touchent"). La ranger dans les Réglages l'aurait mise derrière
 * `settings.write`, donc aurait coupé une seule décision en deux droits distincts.
 *
 * ⚠ LA PHRASE "HORS FACTURE" EST OBLIGATOIRE ET N'EST PAS DE LA DÉCORATION. Un pourcentage rend le
 * malentendu plus facile qu'un montant: "50 % de la facture" se lit spontanément comme une remise
 * faite au client. Le client paie le prix affiché, l'employeur verse la part. Toute copie qui montre
 * un taux doit le redire, sinon quelqu'un finira par sortir cet argent de la mauvaise poche.
 *
 * ⚠ UNE CASE D'ACCORD LAISSÉE VIDE VEUT DIRE "SUIT LE TAUX GÉNÉRAL", et zéro veut dire "zéro". Les
 * deux sont des états réels et différents (voir `rateFor`, qui utilise `??` et non `||` pour cette
 * raison exacte), donc le champ ne doit jamais préremplir le taux général: il l'affiche en indice.
 */
export default function PartEmploye({
  slug,
  canWrite,
  writeReason,
  initial,
  members,
  /** Un prix réel du catalogue, pour montrer ce que le taux donne. null s'il n'y en a aucun. */
  sampleCents,
  /**
   * Le commerce ne peut PAS payer au montant fixe: il n'a pas d'articles (caisse à saisie libre).
   * Le sélecteur de mode disparaît alors au lieu d'offrir un choix qui paierait zéro en silence.
   */
  lockPercent = false,
  vehicleGrades = [],
}: {
  slug: string;
  canWrite: boolean;
  writeReason: string | null;
  initial: CommissionPolicy;
  members: PartEmployeMember[];
  sampleCents: number | null;
  lockPercent?: boolean;
  /** Concession: l'échelle de grades du métier, pour régler % du profit par rang. */
  vehicleGrades?: { grade: number; label: string }[];
}) {
  const [mode, setMode] = useState<CommissionMode>(lockPercent ? "pourcentage" : initial.mode);
  const [rate, setRate] = useState(String(bpsToPercent(initial.bps)));
  const [gradeRates, setGradeRates] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const g of vehicleGrades) {
      const bps = initial.byGrade[String(g.grade)];
      out[String(g.grade)] = bps === undefined ? "" : String(bpsToPercent(bps));
    }
    return out;
  });
  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const m of members) {
      const bps = initial.byEmployee[m.identifier];
      out[m.identifier] = bps === undefined ? "" : String(bpsToPercent(bps));
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const rateBps = percentToBps(rate);
  const rateInvalid = mode === "pourcentage" && rateBps === null;

  /** Les accords hors-bornes, pour refuser AVANT d'envoyer plutôt que d'afficher un refus serveur. */
  const badOverrides = useMemo(
    () =>
      Object.entries(overrides).filter(
        ([, v]) => v.trim() !== "" && percentToBps(v) === null,
      ).length,
    [overrides],
  );

  const dirty = useMemo(() => {
    if (mode !== initial.mode) return true;
    if (mode === "pourcentage" && rateBps !== initial.bps) return true;
    for (const g of vehicleGrades) {
      const raw = gradeRates[String(g.grade)] ?? "";
      const now = raw.trim() === "" ? undefined : (percentToBps(raw) ?? undefined);
      if (now !== initial.byGrade[String(g.grade)]) return true;
    }
    for (const m of members) {
      const raw = overrides[m.identifier] ?? "";
      const now = raw.trim() === "" ? undefined : (percentToBps(raw) ?? undefined);
      if (now !== initial.byEmployee[m.identifier]) return true;
    }
    return false;
  }, [mode, rateBps, overrides, initial, members, gradeRates, vehicleGrades]);

  function submit() {
    if (pending || rateInvalid || badOverrides > 0) return;
    setError(null);
    setSaved(false);

    const byEmployee: Record<string, number> = {};
    for (const m of members) {
      const raw = (overrides[m.identifier] ?? "").trim();
      if (raw === "") continue;
      const bps = percentToBps(raw);
      if (bps !== null) byEmployee[m.identifier] = bps;
    }

    const byGrade: Record<string, number> = {};
    for (const g of vehicleGrades) {
      const raw = (gradeRates[String(g.grade)] ?? "").trim();
      if (raw === "") continue;
      const bps = percentToBps(raw);
      if (bps !== null) byGrade[String(g.grade)] = bps;
    }

    const payload: Partial<CommissionPolicy> = {
      mode,
      bps: rateBps ?? 0,
      byEmployee,
    };
    if (vehicleGrades.length > 0) {
      /**
       * ⚠ ON RENVOIE `vehicleProfitBps` TEL QU'IL EST EN BASE, sans le proposer nulle part.
       * `sanitizeCommission` réécrit la politique en entier à chaque enregistrement: ne pas le
       * joindre le ferait retomber sur le défaut (100 %) au lieu de le laisser tranquille. Il ne
       * sert plus à aucun calcul depuis le 2026-08-27 (voir commission.ts), mais il reste la trace
       * de ce qui a produit les primes déjà versées, et une trace ne s'efface pas par inadvertance
       * en cliquant sur Enregistrer.
       */
      payload.vehicleProfitBps = initial.vehicleProfitBps;
      payload.byGrade = byGrade;
    }

    start(async () => {
      const res = await setCommissionAction(slug, payload);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setSaved(true);
      /**
       * ⚠ RELIRE, ET PAS SEULEMENT POUR CE PANNEAU. Changer de mode change ce que la GRILLE au-dessus
       * doit afficher (le champ de part fixe apparaît ou disparaît par case) et ce que la CAISSE
       * annoncera à chaque employé. Ces écrans lisent le mode ENREGISTRÉ, pas le brouillon d'ici -
       * c'est voulu, un brouillon ne doit rien changer nulle part - donc sans cette relecture le
       * changement paraîtrait n'avoir servi à rien jusqu'au prochain rechargement complet.
       */
      router.refresh();
    });
  }

  const percent = mode === "pourcentage";
  const sample = sampleCents !== null && rateBps !== null ? Math.round((sampleCents * rateBps) / 10_000) : null;

  return (
    <Card className="h-full">
      <CardHeader className="gap-1.5 border-b">
        <div className="flex items-center gap-2">
          <Coins className="size-4 text-primary" aria-hidden="true" />
          <CardTitle>Part employé</CardTitle>
        </div>
        <CardDescription>
          Ce que l&apos;entreprise verse à la personne qui a fait la vente. Jamais retenu sur la
          facture du client.
        </CardDescription>
        {dirty ? (
          <CardAction>
            <Badge variant="outline" className="border-[var(--warn)] text-[var(--warn)]">
              Non enregistré
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-5 pt-4">
        {/* ── Le mode ──────────────────────────────────────────────────────────────────────── */}
        {lockPercent ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
            Ce commerce paie <strong className="font-semibold text-foreground">au pourcentage de la
            facture</strong>, et ne peut pas faire autrement: sa caisse est à saisie libre, donc il
            n&apos;existe aucun article auquel accrocher un montant fixe.
          </p>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                key: "montant" as const,
                icon: Coins,
                label: "Montant par article",
                desc: "Une somme fixe inscrite sur chaque ligne du catalogue. Convient à un catalogue d'articles au prix stable.",
              },
              {
                key: "pourcentage" as const,
                icon: BadgePercent,
                label: "Pourcentage de la facture",
                desc: "Une fraction du montant facturé, la même quel que soit le prix négocié. Convient à une prestation sur mesure.",
              },
            ] as const
          ).map((opt) => {
            const on = mode === opt.key;
            const Icon = opt.icon;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={!canWrite}
                aria-pressed={on}
                onClick={() => setMode(opt.key)}
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
                  on
                    ? "border-primary bg-primary/10"
                    : "border-border hover:border-primary/40 hover:bg-muted/40",
                  !canWrite && "cursor-not-allowed opacity-60",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className={cn("size-4", on ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                  {opt.label}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{opt.desc}</span>
              </button>
            );
          })}
        </div>
        )}

        {vehicleGrades.length > 0 ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <BadgePercent className="size-4 text-primary" aria-hidden="true" />
              <span className="text-sm font-semibold">Véhicules: % du profit par grade</span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Le bénéfice est lu dans le catalogue du jeu, voiture par voiture: prix client moins
              prix concession. Chaque grade touche un pourcentage de ce bénéfice, hors facture
              client. Un champ vide = 0 %.
            </p>
            {/*
              ⚠ LE CHAMP "MARGE (PROFIT) SUR LE PRIX CATALOGUE" A ÉTÉ RETIRÉ LE 2026-08-27, ET NE
              DOIT PAS REVENIR. C'était un pourcentage de marge estimé à la main, identique pour
              tous les modèles, faute de connaître le coût réel d'une voiture. Il valait 100 % par
              défaut et il était resté à 100 % sur les deux concessions du serveur, donc "5 % du
              profit" payait 5 % du PRIX ENTIER: 8 000 $ de prime à un stagiaire sur une Raiden à
              160 000 $. Le coût réel se lit maintenant dans FleetRoster (`dealerPrice`), donc plus
              rien n'a besoin de l'estimer, et un champ qui n'influence plus le calcul est pire
              qu'absent: il se règle, il s'enregistre, et il ne fait rien.
            */}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Une voiture dont le catalogue ne donne pas de prix concession a un bénéfice de zéro:
              elle se vend et se facture normalement, mais elle ne verse aucune part.
            </p>
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
              {vehicleGrades.map((g) => {
                const key = String(g.grade);
                const raw = gradeRates[key] ?? "";
                const bad = raw.trim() !== "" && percentToBps(raw) === null;
                return (
                  <div key={key} className="flex flex-wrap items-center gap-3 p-2.5">
                    <span className="flex min-w-[160px] flex-1 flex-col">
                      <span className="text-sm font-medium">{g.label}</span>
                      <span className="text-xs text-muted-foreground">Grade {g.grade}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={bpsToPercent(MAX_COMMISSION_BPS)}
                        step={0.1}
                        value={raw}
                        disabled={!canWrite}
                        placeholder="0"
                        onChange={(e) => setGradeRates((o) => ({ ...o, [key]: e.target.value }))}
                        className={cn("w-24", bad && "border-destructive")}
                        aria-label={`Part véhicule ${g.label}`}
                      />
                      <span className="text-sm text-muted-foreground">% du profit</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {percent ? (
          <>
            {/* ── Le taux général ──────────────────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-muted/30 p-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                  Taux de la maison
                </span>
                <span className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={bpsToPercent(MAX_COMMISSION_BPS)}
                    step={0.1}
                    value={rate}
                    disabled={!canWrite}
                    onChange={(e) => setRate(e.target.value)}
                    className={cn("w-28", rateInvalid && "border-destructive")}
                    aria-invalid={rateInvalid}
                  />
                  <span className="text-sm font-semibold text-muted-foreground">%</span>
                </span>
              </label>

              <p className="flex-1 min-w-[220px] text-xs leading-relaxed text-muted-foreground">
                {rateInvalid ? (
                  <span className="text-destructive">
                    Un taux va de 0 à {bpsToPercent(MAX_COMMISSION_BPS)} %.
                  </span>
                ) : sample !== null && sampleCents ? (
                  <>
                    Sur une facture de{" "}
                    <strong className="font-semibold text-foreground">{money(sampleCents)}</strong>, la
                    personne touche{" "}
                    <strong className="font-semibold text-foreground">{money(sample)}</strong>, et le
                    client paie toujours {money(sampleCents)}.
                  </>
                ) : (
                  <>
                    S&apos;applique à tout le monde, sauf à qui porte un accord ci-dessous. Le client
                    paie le prix affiché: cette part sort de la caisse de l&apos;entreprise.
                  </>
                )}
              </p>
            </div>

            {/* ── Les accords personnels ───────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-semibold">Accords particuliers</span>
                <span className="text-xs text-muted-foreground">
                  {members.length} personne{members.length > 1 ? "s" : ""} dans l&apos;effectif
                </span>
              </div>

              {members.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  Personne ne porte ce métier en jeu pour le moment. L&apos;effectif se lit dans le
                  jeu, il n&apos;y a rien à saisir ici.
                </p>
              ) : (
                <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {members.map((m) => {
                    const raw = overrides[m.identifier] ?? "";
                    const custom = raw.trim() !== "";
                    const bad = custom && percentToBps(raw) === null;
                    return (
                      <div key={m.identifier} className="flex flex-wrap items-center gap-3 p-2.5">
                        <span className="flex min-w-[160px] flex-1 flex-col">
                          <span className="text-sm font-medium">{m.name}</span>
                          <span className="text-xs text-muted-foreground">{m.gradeLabel}</span>
                        </span>

                        <span className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={bpsToPercent(MAX_COMMISSION_BPS)}
                            step={0.1}
                            value={raw}
                            disabled={!canWrite}
                            // ⚠ L'indice affiche le taux général, il ne le PRÉREMPLIT pas: un champ
                            // prérempli s'enregistrerait comme un accord, donc figerait la personne
                            // sur la valeur du jour et la laisserait derrière la prochaine fois que
                            // la maison remonte son taux.
                            placeholder={rateBps === null ? "—" : String(bpsToPercent(rateBps))}
                            onChange={(e) =>
                              setOverrides((o) => ({ ...o, [m.identifier]: e.target.value }))
                            }
                            className={cn("w-24", bad && "border-destructive")}
                            aria-invalid={bad}
                            aria-label={`Taux de ${m.name}`}
                          />
                          <span className="text-sm text-muted-foreground">%</span>
                        </span>

                        {/* ⚠ La colonne dit soit CE QUI S'APPLIQUE (pas d'accord: le taux de la
                            maison, en toutes lettres), soit COMMENT Y REVENIR (accord: un bouton
                            dont le libellé est un verbe). Un même mot pour les deux se lisait
                            comme une étiquette et personne ne cliquait dessus. */}
                        <span className="w-[128px] shrink-0 text-right">
                          {custom && !bad ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!canWrite}
                              onClick={() => setOverrides((o) => ({ ...o, [m.identifier]: "" }))}
                            >
                              Suivre le taux
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              taux maison {rateBps === null ? "—" : formatRate(rateBps)}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
            En montant fixe, la part se règle <strong className="font-semibold text-foreground">article
            par article</strong>, sur la fiche de chaque tarif. Les accords personnels n&apos;existent
            que pour un pourcentage: un montant, lui, appartient à l&apos;article, pas à la personne.
          </p>
        )}
      </CardContent>

      <CardFooter className="mt-auto flex-wrap gap-2">
        <Button disabled={!canWrite || pending || rateInvalid || badOverrides > 0} onClick={submit}>
          {pending ? "Enregistrement…" : "Enregistrer la part"}
        </Button>
        {!canWrite ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" aria-hidden="true" />
            {writeReason ?? "Modification verrouillée."}
          </span>
        ) : error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : saved && !dirty ? (
          <span className="text-xs text-muted-foreground">Enregistré.</span>
        ) : (
          <span className="flex-1 min-w-[200px] text-xs leading-relaxed text-muted-foreground">
            S&apos;applique aux ventes déclarées À PARTIR DE MAINTENANT. Les tickets déjà enregistrés
            gardent la part qui s&apos;appliquait le jour où ils ont été faits.
          </span>
        )}
      </CardFooter>
    </Card>
  );
}
