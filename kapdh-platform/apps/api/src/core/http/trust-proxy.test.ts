import { describe, expect, it } from "vitest";
import { isPrivatePeer, trustProxyHops } from "./trust-proxy.js";

describe("trust proxy TRUST_PROXY_HOPS (PRD 2.5, N-07; fastify >= 5.12 tanpa hop-count numerik)", () => {
  it("peer privat/loopback dikenali, termasuk IPv4-mapped IPv6", () => {
    for (const a of [
      "10.0.1.5",
      "172.18.0.3",
      "192.168.1.10",
      "127.0.0.1",
      "::1",
      "fd00::5",
      "::ffff:172.18.0.3",
    ])
      expect(isPrivatePeer(a), a).toBe(true);
    for (const a of [
      "203.0.113.9",
      "8.8.8.8",
      "172.32.0.1",
      "2001:db8::1",
      "::ffff:203.0.113.9",
      "",
      undefined,
    ])
      expect(isPrivatePeer(a), String(a)).toBe(false);
  });

  it("0 hop: tidak mempercayai proxy apa pun", () => {
    expect(trustProxyHops(0)).toBe(false);
  });

  it("1 hop: hanya peer langsung privat (Traefik) yang dipercaya; klien publik langsung tidak", () => {
    const trust = trustProxyHops(1);
    expect(trust).not.toBe(false);
    if (trust === false) return;
    expect(trust("172.18.0.3", 0)).toBe(true);
    expect(trust("203.0.113.50", 0)).toBe(false);
    expect(trust("172.18.0.3", 1)).toBe(false);
  });

  it("2 hop: hop kedua boleh beralamat publik (CDN di depan Traefik), peer langsung tetap wajib privat", () => {
    const trust = trustProxyHops(2);
    if (trust === false) throw new Error("harus fungsi");
    expect(trust("10.0.0.2", 0)).toBe(true);
    expect(trust("198.51.100.1", 1)).toBe(true);
    expect(trust("198.51.100.1", 2)).toBe(false);
    expect(trust("198.51.100.1", 0)).toBe(false);
  });
});
