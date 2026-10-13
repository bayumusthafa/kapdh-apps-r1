import { describe, expect, it } from "vitest";
import { deepLinkFor, isNotificationRoute } from "./app-routes.js";

const ID = "01968f4e-8c2a-7b3d-9e4f-123456789abc";

describe("Rute deep link notifikasi (ARCHITECTURE §4.7, §8.4; AC F13-3)", () => {
  it("menerima rute aplikasi relatif §8.4 beserta parameter yang sah", () => {
    for (const route of [
      "/kta",
      "/home",
      `/payments/${ID}`,
      "/payments/new/renewal",
      `/events/${ID}`,
      `/tickets/${ID}`,
      `/chat/${ID}`,
      `/chat/${ID}/info`,
      "/chat/invitations",
      "/news/kegiatan-reuni-2026",
      "/legal/kebijakan-privasi",
      "/restricted",
      "/renewal",
      "/onboarding/fees",
    ])
      expect(isNotificationRoute(route), route).toBe(true);
  });

  it("menolak URL eksternal, query/fragmen, traversal, parameter salah bentuk, dan rute sistem/auth", () => {
    for (const route of [
      "https://contoh.test/kta",
      "//contoh.test/kta",
      "kapdh://app/kta",
      "/kta?x=1",
      "/kta#bagian",
      "/payments/../admin",
      "/payments/123",
      "/payments/new/ticket",
      `/payments/${ID.toUpperCase()}`,
      "/news/Judul Berita",
      "/login",
      "/splash",
      "/register/otp",
      "kta",
      "",
      `/chat/${ID}/info/extra`,
    ])
      expect(isNotificationRoute(route), route).toBe(false);
  });

  it("bentuk eksternal kapdh://app<rute>; null tetap null", () => {
    expect(deepLinkFor(`/payments/${ID}`)).toBe(`kapdh://app/payments/${ID}`);
    expect(deepLinkFor(null)).toBeNull();
  });
});
