import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth/config";
import { resolveSessionIdentity } from "@/lib/auth/session";
import { can, type Identity } from "@/lib/auth/identity";
import { CODES } from "@/lib/auth/codes";
import { getCadAccess } from "@/lib/cad/access";
import { isIngameTabletEmbedRequest } from "@/lib/security/ingameEmbedRequest";
import { headers } from "next/headers";

/**
 * OU ENVOYER QUELQU'UN APRES LA CONNEXION, SELON LA MARQUE PAR LAQUELLE IL EST ENTRE.
 *
 * ⚠ La destination etait ecrite en dur a "/staff", aux DEUX endroits ci-dessous. Sur
 * lifeinvader.grandside.org, le middleware reecrit tout chemin en `/business/...`, donc "/staff"
 * devenait `/business/staff`, une route qui n'existe pas: un joueur se connectait correctement et
 * atterrissait sur un 404. La connexion marchait, c'est l'arrivee qui etait cassee, ce qui est bien
 * plus deroutant qu'un refus.
 *
 * On renvoie sur "/" pour la marque joueur (le middleware en fait `/business`, donc l'adresse reste
 * propre et sans prefixe visible) et sur "/staff" pour la marque staff.
 */
async function landingPath(tabletEmbed: boolean, identity: Identity | null): Promise<string> {
  if (tabletEmbed) return "/cad";
  const h = await headers();
  const host = (h.get("x-forwarded-host") || h.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  const businessHost = (process.env.BUSINESS_HOST || "lifeinvader.grandside.org").toLowerCase();
  if (host === businessHost) return "/";
  // Staff brand: land where the account actually has a door (owner, 2026-08-26: "if player tires to
  // signin to staff and only has access to cad it should redirect to cad"). Staff panel first; a
  // CAD-only magistrate or officer goes to /cad instead of bouncing off /staff's denial screen.
  if (identity && !can(identity, CODES.STAFF_PANEL)) {
    const cad = await getCadAccess(identity);
    if (cad.hasAny) return "/cad";
  }
  return "/staff";
}

/**
 * A caller-supplied return path is honoured ONLY as an internal absolute path: no "//host", no
 * scheme, no backslash tricks. Anything else falls back to the brand landing - an open redirect on
 * the login page is exactly the phishing primitive this refuses to become.
 */
function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("://") || next.includes("\\")) return null;
  return next;
}

/**
 * L'ICONE ET LE TITRE DE LA PORTE D'ENTREE, SELON LA MARQUE.
 *
 * ⚠ `/login` est volontairement HORS de la reecriture par hote (sinon il deviendrait
 * `/business/login`, qui n'existe pas, et plus personne ne pourrait se connecter). Il ne beneficie
 * donc PAS de `src/app/business/icon.png`, qui ne couvre que le segment /business. Sans ce bloc, un
 * joueur qui arrive sur lifeinvader.grandside.org/login voit l'onglet et l'icone de CITADEL, c'est
 * a dire la marque du staff, sur la seule page ou il n'a encore rien vu d'autre.
 */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") || h.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  const businessHost = (process.env.BUSINESS_HOST || "lifeinvader.grandside.org").toLowerCase();
  if (host !== businessHost) return {};
  return {
    title: "LifeInvader Entreprises",
    icons: { icon: "/lifeinvader-logo.png" },
  };
}

/**
 * The front door. Per the design, @aceternity's aesthetic belongs HERE and nowhere else - but even
 * here, restraint: this is a door staff walk through daily, not a marketing page.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const nextPath = safeNext(next);
  const session = await auth();
  const tabletEmbed = await isIngameTabletEmbedRequest();
  const ingameAuthError =
    error === "bad-code" || error === "no-character" || error === "ingame-denied";
  const hideDiscordOAuth = tabletEmbed || ingameAuthError;

  // Already signed in AND linked -> straight through (Discord OAuth or in-game redeem). A validated
  // `next` wins over the brand landing so a /cad-bound sign-in returns to the CAD, never /staff.
  if (error !== "denied" && session?.user) {
    const identity = await resolveSessionIdentity();
    if (identity) redirect(nextPath ?? (await landingPath(tabletEmbed, identity)));
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex w-[340px] flex-col items-center gap-[22px]">
        <Image
          src="/grandside-logo.png"
          alt="GrandSide"
          width={160}
          height={160}
          priority
          className="h-40 w-40 drop-shadow-[0_8px_28px_rgba(0,0,0,0.55)]"
        />

        <div className="flex flex-col items-center gap-1.5">
          <div className="-mr-[0.34em] font-mono text-[26px] font-semibold uppercase tracking-[0.34em]">
            Citadel
          </div>
          <p className="text-center text-sm text-muted-foreground">
            Plateforme d&apos;opérations du staff - GrandSide
          </p>
        </div>

        {error === "unlinked" && (
          <div className="w-full rounded-md border border-border bg-surface p-4 text-sm">
            <p className="font-medium text-warning">Compte Discord non lié</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              Ton compte Discord n&apos;est lié à aucun personnage. La liaison se fait à la
              connexion en jeu - rejoins le serveur une fois, puis reviens.
            </p>
          </div>
        )}

        {error === "denied" && (
          <div className="w-full rounded-md border border-border bg-surface p-4 text-sm">
            <p className="font-medium text-warning">accès staff refusé</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              ton compte est bien lié, mais ce personnage n&apos;a pas accès au panneau staff.
              si tu viens de créer un nouveau personnage, reconnecte-toi en jeu pour laisser la
              liaison se mettre à jour. sinon, demande à un fondateur de vérifier ton rang.
            </p>
          </div>
        )}

        {error === "bad-code" && (
          <div className="w-full rounded-md border border-border bg-surface p-4 text-sm">
            <p className="font-medium text-warning">Lien expiré ou invalide</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              Ferme le MDT, puis rouvre-le avec <span className="font-mono text-foreground">/cad</span>{" "}
              ou F6 (en service). Le code ne dure que deux minutes.
            </p>
          </div>
        )}

        {error === "no-character" && (
          <div className="w-full rounded-md border border-border bg-surface p-4 text-sm">
            <p className="font-medium text-warning">Personnage introuvable</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              Aucun personnage lié à ce code. Reconnecte-toi en jeu, puis réessaie{" "}
              <span className="font-mono text-foreground">/cad</span>.
            </p>
          </div>
        )}

        {hideDiscordOAuth ? (
          <div className="w-full rounded-md border border-border bg-surface p-4 text-sm text-center text-muted-foreground">
            La connexion Discord ne fonctionne pas dans la tablette en jeu. Utilise{" "}
            <span className="font-mono text-foreground">/cad</span> ou F6 depuis le serveur.
          </div>
        ) : (
          <form
            className="w-full"
            action={async () => {
              "use server";
              // Return THROUGH /login (with the validated next) rather than straight to a fixed
              // landing: the post-OAuth pass above is where identity-aware routing lives, so the
              // decision is made once, with the identity in hand.
              await signIn("discord", {
                redirectTo: nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login",
              });
            }}
          >
            <button
              type="submit"
              className="flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground transition-[filter] hover:brightness-110"
            >
              Connexion via Discord
            </button>
          </form>
        )}

        {!hideDiscordOAuth && (
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Accès réservé au staff. En jeu, tapez{" "}
            <span className="font-mono text-foreground">/citadel</span> pour recevoir votre lien de
            connexion.
          </p>
        )}
      </div>
    </main>
  );
}
