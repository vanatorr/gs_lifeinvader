import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { redeemAuthCode } from "@/lib/auth/ingame";
import { setIngameAuthSessionCookie } from "@/lib/auth/ingameSessionCookie";
import { auditAccount } from "@/lib/audit";
import { checkRateLimit, clientIp, envInt } from "@/lib/security/rateLimit";

/**
 * The landing point for `/citadel` in game: <front>/auth/ingame?code=…
 *
 * A GET that mutates is normally a smell, but this is a link a player CLICKS out of a chat box -
 * it cannot be a POST. The code is single-use and expires in ~2 minutes, so a prefetch or a repeat
 * visit simply fails closed rather than doing anything twice.
 *
 * The redirect immediately drops the code from the address bar, so it never lands in history as
 * something that looks live. It is already spent by then regardless.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH_CODE_LIMIT = envInt("CITADEL_INGAME_AUTH_RATE_LIMIT", 20);
const AUTH_CODE_WINDOW_MS = envInt("CITADEL_INGAME_AUTH_RATE_WINDOW_MS", 60_000);

export async function GET(req: Request) {
  const limited = checkRateLimit(
    `auth:ingame:${clientIp(req)}`,
    AUTH_CODE_LIMIT,
    AUTH_CODE_WINDOW_MS,
  );
  if (!limited.allowed) redirect("/login?error=rate-limited");

  const code = new URL(req.url).searchParams.get("code") ?? "";
  const result = await redeemAuthCode(code);

  if (!result.ok) {
    redirect(`/login?error=${result.reason === "no-character" ? "no-character" : "bad-code"}`);
  }

  // Same cookie Auth.js reads for database sessions, so the rest of the app cannot tell which path
  // minted it - which is exactly the "ONE session" requirement.
  const jar = await cookies();
  setIngameAuthSessionCookie(jar, result.sessionToken, result.expires, req);

  try {
    await auditAccount(result.accountId, {
      panel: "auth",
      action: "staff.login",
      targetType: "auth",
      targetId: "ingame_code",
      data: { method: "ingame_code", route: result.route },
    });
  } catch {
    // Do not fail login on an audit mirror/write.
  }

  // Deep-link: mint may store "cad" (generic) or "cad/<agencyId>" (duty tablet).
  // Agency id was validated server-side against ConfigCitadel.Cad.Agencies before mint.
  const route = result.route ?? "";
  if (route === "cad") {
    redirect("/cad");
  }
  const agencyMatch = /^cad\/([a-z0-9_-]+)$/i.exec(route);
  if (agencyMatch) {
    redirect(`/cad/${agencyMatch[1].toLowerCase()}`);
  }
  if (route === "profile") {
    redirect("/profile");
  }
  redirect("/staff");
}
