import { isIP } from "node:net";

// Ranges that a web fetch must never reach: loopback, private, link-local (including cloud metadata),
// carrier-grade NAT, multicast and reserved space.
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.some(([base, bits]) => inRange(ipv4ToInt(address), ipv4ToInt(base), bits));
  if (family === 6) return isPublicV6(address.toLowerCase());
  return false;
}

function isPublicV6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] !== undefined) return isPublicAddress(mapped[1]);
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function inRange(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}
