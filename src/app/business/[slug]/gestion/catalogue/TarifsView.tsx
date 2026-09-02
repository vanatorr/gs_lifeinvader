"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import type { CommissionPolicy } from "@/lib/business/commission";
import { money } from "@/lib/business/theme";
import { setLineCeilingAction } from "./actions";
import PartEmploye, { type PartEmployeMember } from "./PartEmploye";

/**
 * LA PAGE TARIFS D'UN SALON: deux réglages, et c'est tout.
 *
 * ⚠ IL N'Y A PAS DE CATALOGUE ICI, ET CE N'EST PAS UN OUBLI. La caisse d'un salon est une saisie
 * libre: l'employé tape le prix de chaque pièce (voir `CaisseGrilleView`). La direction ne fixe donc
 * pas des prix, elle fixe une BORNE et un PARTAGE.
 *
 * ⚠⚠ LE PLAFOND N'EST PAS UN CONFORT, C'EST LE SEUL GARDE-FOU DE CETTE CAISSE. Partout ailleurs sur
 * le portail le prix vient de la base et le navigateur n'envoie que des identifiants. Ici il envoie
 * un montant, et la part employé est un POURCENTAGE de ce montant: sans plafond, qui peut taper le
 * prix peut taper sa paie, et l'employeur le découvre en fin de semaine. La page le dit en toutes
 * lettres, parce qu'un réglage dont on ignore l'enjeu finit à une valeur ronde choisie au hasard.
 */
export default function TarifsView({
  slug,
  name,
  canRead,
  readReason,
  canWrite,
  writeReason,
  labelPrefix,
  slots,
  lineMaxCents,
  commission,
  members,
}: {
  slug: string;
  name: string;
  canRead: boolean;
  readReason: string | null;
  canWrite: boolean;
  writeReason: string | null;
  labelPrefix: string;
  slots: number;
  lineMaxCents: number | null;
  commission: CommissionPolicy;
  members: PartEmployeMember[];
}) {
  const [ceiling, setCeiling] = useState(
    lineMaxCents === null ? "" : String(Math.round(lineMaxCents / 100)),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const parsed = Math.round(Number(ceiling));
  const valid = ceiling.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const dirty = valid && parsed * 100 !== lineMaxCents;

  function save() {
    if (!valid || pending) return;
    setError(null);
    setSaved(false);
    start(async () => {
      const res = await setLineCeilingAction(slug, parsed);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setSaved(true);
      // La caisse lit ce plafond à chaque rendu: sans relecture, l'écran garde l'ancienne valeur de
      // référence et continue d'annoncer une modification en attente juste après l'avoir enregistrée.
      router.refresh();
    });
  }

  if (!canRead) {
    return (
      <>
        <div className="head">
          <h1>Tarifs</h1>
          <span className="sub">{name}</span>
        </div>
        <Alert className="border-[var(--warn)] [&>svg]:text-[var(--warn)]">
          <Lock />
          <AlertTitle>Cette page vous est fermée.</AlertTitle>
          <AlertDescription className="text-foreground/85">{readReason}</AlertDescription>
        </Alert>
      </>
    );
  }

  return (
    <>
      <div className="head">
        <h1>Tarifs</h1>
        <span className="sub">{name}</span>
      </div>

      {!canWrite ? (
        <Alert className="mb-4 border-[var(--warn)] [&>svg]:text-[var(--warn)]">
          <Lock />
          <AlertTitle>Modification verrouillée.</AlertTitle>
          <AlertDescription className="text-foreground/85">
            {writeReason} Tout reste consultable, rien n&apos;est enregistrable.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="figs">
        <div className="fig">
          <div className="k cap">Plafond par {labelPrefix.toLowerCase()}</div>
          <div className="v lead">{lineMaxCents === null ? "—" : money(lineMaxCents)}</div>
          <div className="m">{lineMaxCents === null ? "à régler avant toute vente" : "refusé au-dessus"}</div>
        </div>
        <div className="fig">
          <div className="k cap">Part employé</div>
          <div className="v">
            {commission.mode === "pourcentage" ? `${commission.bps / 100} %` : "Par article"}
          </div>
          <div className="m">de la facture, hors facture client</div>
        </div>
        <div className="fig">
          <div className="k cap">Cases à la caisse</div>
          <div className="v">{slots}</div>
          <div className="m">
            {labelPrefix} 1 à {slots}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="gap-1.5 border-b">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-primary" aria-hidden="true" />
              <CardTitle>Prix maximum d&apos;un {labelPrefix.toLowerCase()}</CardTitle>
            </div>
            <CardDescription>
              La caisse de ce salon est à saisie libre: l&apos;employé inscrit lui-même le prix de
              chaque pièce. Cette valeur est la seule borne.
            </CardDescription>
            {dirty ? (
              <CardAction>
                <Badge variant="outline" className="border-[var(--warn)] text-[var(--warn)]">
                  Non enregistré
                </Badge>
              </CardAction>
            ) : null}
          </CardHeader>

          <CardContent className="flex flex-col gap-4 pt-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Elle compte <strong className="font-semibold text-foreground">plus qu&apos;un
              confort</strong>: la part employé est un pourcentage de ce que l&apos;employé vient de
              taper, donc sans plafond, qui fixe le prix fixe aussi sa propre paie, et vous le
              découvrez à la fin de la semaine. Mettez-la au-dessus de votre plus grosse pièce, pas
              au-dessus de ce que vous accepteriez de payer.
            </p>

            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                  Maximum par {labelPrefix.toLowerCase()}
                </span>
                <span className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={ceiling}
                    disabled={!canWrite}
                    placeholder="—"
                    onChange={(e) => setCeiling(e.target.value)}
                    className={cn("w-36 text-base font-semibold tabular-nums", !valid && ceiling.trim() !== "" && "border-destructive")}
                    aria-invalid={!valid && ceiling.trim() !== ""}
                    aria-label={`Prix maximum d'un ${labelPrefix.toLowerCase()}`}
                  />
                  <span className="text-sm font-semibold text-muted-foreground">$</span>
                </span>
              </label>

              <p className="flex-1 min-w-[220px] text-xs leading-relaxed text-muted-foreground">
                {valid ? (
                  <>
                    Un employé pourra facturer jusqu&apos;à{" "}
                    <strong className="font-semibold text-foreground">{money(parsed * 100)}</strong>{" "}
                    par {labelPrefix.toLowerCase()}, et jusqu&apos;à{" "}
                    <strong className="font-semibold text-foreground">
                      {money(parsed * 100 * slots)}
                    </strong>{" "}
                    sur un seul ticket de {slots} lignes.
                  </>
                ) : (
                  <span className="text-destructive">
                    Mettez un montant entier supérieur à zéro. Tant qu&apos;il manque, aucune vente
                    ne peut être déclarée à la caisse de ce salon.
                  </span>
                )}
              </p>
            </div>
          </CardContent>

          <CardFooter className="flex-wrap gap-2">
            <Button disabled={!canWrite || !valid || !dirty || pending} onClick={save}>
              {pending ? "Enregistrement…" : "Enregistrer le plafond"}
            </Button>
            {error ? (
              <span className="text-xs text-destructive">{error}</span>
            ) : saved && !dirty ? (
              <span className="text-xs text-muted-foreground">Enregistré.</span>
            ) : (
              <span className="flex-1 min-w-[200px] text-xs leading-relaxed text-muted-foreground">
                S&apos;applique aux ventes déclarées à partir de maintenant. Les tickets déjà
                enregistrés ne bougent pas.
              </span>
            )}
          </CardFooter>
        </Card>

        <PartEmploye
          slug={slug}
          canWrite={canWrite}
          writeReason={writeReason}
          initial={commission}
          members={members}
          sampleCents={lineMaxCents}
          /**
           * ⚠ Le mode "montant par article" est INAPPLICABLE ici et le panneau ne le propose donc
           * pas: un salon n'a aucun article, donc une part fixe PAR ARTICLE n'aurait rien à quoi
           * s'accrocher et paierait zéro en silence. `setCommissionAction` force d'ailleurs le
           * pourcentage côté serveur pour un commerce en grille, ce qui rend l'interface et la règle
           * cohérentes plutôt que seulement d'accord par habitude.
           */
          lockPercent
        />
      </div>
    </>
  );
}
