import { isIP } from "node:net";

const blockedHostnames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
  "host.docker.internal",
  "gateway.docker.internal"
]);

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4]
  ];

  return ranges.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function ipv6ToBigInt(input: string): bigint {
  let address = input.toLowerCase();
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) {
    address = address.slice(0, zoneIndex);
  }

  const lastColon = address.lastIndexOf(":");
  const possibleIpv4 = address.slice(lastColon + 1);
  if (possibleIpv4.includes(".")) {
    if (isIP(possibleIpv4) !== 4) {
      throw new Error("Invalid IPv4 tail in IPv6 address");
    }
    const bytes = possibleIpv4.split(".").map(Number);
    const first = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    const second = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    address = `${address.slice(0, lastColon)}:${first.toString(16)}:${second.toString(16)}`;
  }

  const doubleColonParts = address.split("::");
  if (doubleColonParts.length > 2) {
    throw new Error("Invalid IPv6 address");
  }
  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (doubleColonParts.length === 1 && missing !== 0)) {
    throw new Error("Invalid IPv6 address");
  }
  const segments = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right
  ];
  if (segments.length !== 8) {
    throw new Error("Invalid IPv6 address");
  }

  return segments.reduce((value, segment) => {
    if (!/^[a-f0-9]{1,4}$/i.test(segment)) {
      throw new Error("Invalid IPv6 address");
    }
    return (value << 16n) | BigInt(`0x${segment}`);
  }, 0n);
}

function inIpv6Cidr(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === network >> shift;
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  const globalUnicast = inIpv6Cidr(value, 0x20000000000000000000000000000000n, 3);
  const documentation = inIpv6Cidr(value, 0x20010db8000000000000000000000000n, 32);
  return !globalUnicast || documentation;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address);
  const version = isIP(normalized);
  if (version === 4) {
    return isBlockedIpv4(normalized);
  }
  if (version === 6) {
    return isBlockedIpv6(normalized);
  }
  throw new Error(`Not an IP address: ${address}`);
}

export function assertSafeSourceUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Source URL is invalid");
  }

  // Production source ingestion is HTTPS-only.  Plain HTTP would expose
  // feed contents and redirect decisions to on-path tampering; local test
  // transports can still exercise HTTP by bypassing this public URL policy.
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS source URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Source URL credentials are forbidden");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Source URLs must use HTTPS port 443");
  }
  if (!parsed.hostname) {
    throw new Error("Source URL hostname is required");
  }

  const hostname = stripIpv6Brackets(parsed.hostname.toLowerCase());
  if (
    blockedHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Local and metadata hostnames are forbidden");
  }

  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw new Error("Private, local, reserved, and metadata addresses are forbidden");
  }

  parsed.hash = "";
  return parsed.toString();
}

export function validateResolvedAddresses(addresses: string[]): string[] {
  if (addresses.length === 0) {
    throw new Error("DNS returned no addresses");
  }
  for (const address of addresses) {
    if (isIP(address) === 0 || isBlockedAddress(address)) {
      throw new Error("DNS answer contains a forbidden address");
    }
  }
  return [...new Set(addresses)];
}
