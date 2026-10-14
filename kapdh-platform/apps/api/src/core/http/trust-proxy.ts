import { BlockList, isIP } from "node:net";

/**
 * Kepercayaan proxy untuk req.ip/protocol/host (PRD 2.5 rate limit per IP, N-07; TRUST_PROXY_HOPS).
 *
 * Fastify >= 5.12 menolak `trustProxy` berupa angka (hop-count tanpa memeriksa peer langsung membuat klien yang
 * terhubung langsung dapat memalsukan X-Forwarded-*, GHSA-3m5p-2c4r-xxw2) dan memperlakukannya sebagai "tidak
 * percaya", sehingga semua permintaan akan tercatat dengan IP Traefik. Fungsi ini mempertahankan semantik hop-count
 * TRUST_PROXY_HOPS DAN mensyaratkan peer langsung (hop 0) beralamat jaringan privat/loopback, yaitu Traefik di
 * jaringan Docker (PRD 5.3: API tidak pernah dipublikasikan langsung). Klien beralamat publik yang menjangkau API
 * langsung tidak pernah dipercaya: X-Forwarded-For/Proto/Host miliknya diabaikan.
 */
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("::1", 128, "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");

/** Alamat peer berada di jaringan privat/loopback (termasuk IPv4-mapped IPv6 `::ffff:a.b.c.d`). */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  const plain = lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
  const family = isIP(plain);
  if (family === 4) return PRIVATE_NETWORKS.check(plain, "ipv4");
  if (family === 6) return PRIVATE_NETWORKS.check(plain, "ipv6");
  return false;
}

/**
 * Opsi `trustProxy` Fastify untuk TRUST_PROXY_HOPS: `false` bila 0; selain itu fungsi (alamat, hop) yang mempercayai
 * `hops` proxy terakhir, dengan peer langsung wajib privat.
 */
export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  if (!Number.isInteger(hops) || hops <= 0) return false;
  return (address: string, hop: number) => hop < hops && (hop > 0 || isPrivatePeer(address));
}
