import type { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

/**
 * Session cookie for /auth/ingame redeem inside gs_website's iframe.
 *
 * The CEF parent is nui:// (cross-site). SameSite=Lax Set-Cookie in that context is dropped by
 * Chromium, so /cad immediately bounces to /login and the tablet looks blank.
 */
export function setIngameAuthSessionCookie(
  jar: ResponseCookies,
  sessionToken: string,
  expires: Date,
  req: Request,
): void {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const secure =
    forwardedProto === "https" ||
    (forwardedProto !== "http" && new URL(req.url).protocol === "https:") ||
    (forwardedProto !== "http" && process.env.NODE_ENV === "production");
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  jar.set(name, sessionToken, {
    httpOnly: true,
    path: "/",
    expires,
    secure,
    sameSite: secure ? "none" : "lax",
  });
}
