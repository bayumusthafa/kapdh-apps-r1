/**
 * Rute aplikasi Flutter yang boleh menjadi tujuan deep link notifikasi (ARCHITECTURE §4.7, §8.4). Deep link selalu
 * rute RELATIF aplikasi (mis. `/payments/<id>`), tidak pernah URL eksternal; bentuk eksternalnya
 * `kapdh://app<rute>`. Aplikasi tetap memeriksa autentikasi/otorisasi sebelum membuka objek (AC F13-3), jadi daftar
 * ini menjaga bentuk, bukan izin. Rute sistem/auth (splash, login, OTP) bukan tujuan notifikasi.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

const PARAMS: Record<string, string> = {
  ":paymentId": UUID,
  ":eventId": UUID,
  ":ticketId": UUID,
  ":userId": UUID,
  ":roomId": UUID,
  ":slug": SLUG,
  ":type": "(?:registration|renewal)",
};

/** Pola rute §8.4 yang dapat dituju notifikasi. */
export const NOTIFICATION_ROUTE_PATTERNS = [
  "/home",
  "/events",
  "/kta",
  "/network",
  "/account",
  "/onboarding/fees",
  "/payments",
  "/payments/new/:type",
  "/payments/:paymentId",
  "/renewal",
  "/news",
  "/news/:slug",
  "/events/:eventId",
  "/tickets",
  "/tickets/:ticketId",
  "/network/members/:userId",
  "/chat/invitations",
  "/chat/:roomId",
  "/chat/:roomId/info",
  "/notifications",
  "/account/profile",
  "/account/privacy",
  "/account/notifications",
  "/account/sessions",
  "/account/password",
  "/account/blocked",
  "/account/reports",
  "/account/delete",
  "/legal/:slug",
  "/restricted",
  "/deletion-status",
] as const;

const ROUTE_REGEXES = NOTIFICATION_ROUTE_PATTERNS.map(
  (pattern) =>
    new RegExp(
      `^${pattern
        .split("/")
        .map((segment) => PARAMS[segment] ?? segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("/")}$`,
    ),
);

/** true bila `route` adalah rute aplikasi yang sah untuk deep link notifikasi (tanpa query, fragmen, atau host). */
export function isNotificationRoute(route: string): boolean {
  return route.length <= 200 && ROUTE_REGEXES.some((regex) => regex.test(route));
}

/** Bentuk eksternal deep link (`kapdh://app/payments/<id>`), dipakai payload push dan event realtime. */
export function deepLinkFor(route: string | null): string | null {
  return route ? `kapdh://app${route}` : null;
}
