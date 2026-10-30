// Address checks for form fields, as you type: the same formats the engine's schema takes
// (packages/schema/src/primitives.ts). How addresses fit together (inside the CIDR, ranges that
// don't overlap) is the engine's to say; its problems show under the field too.

const OCTET = "(25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const IPV4 = new RegExp(`^(${OCTET}\\.){3}${OCTET}$`);

export type AddressFormat = "ip" | "cidr";

export const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join(".");

/** What's wrong with an address, or undefined. Templates and empty values aren't checked. */
export function addressProblem(value: unknown, format: AddressFormat): string | undefined {
  if (typeof value !== "string" || value === "" || value.includes("{{")) return undefined;
  const v = value.trim();
  if (format === "ip") return IPV4.test(v) ? undefined : `${v} isn't an IPv4 address, like 10.0.20.1`;
  const [ip, bits, ...rest] = v.split("/");
  if (rest.length || bits === undefined || !IPV4.test(ip) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return `${v} isn't a CIDR, like 10.0.20.0/24`;
  const size = 2 ** (32 - Number(bits));
  const start = toInt(ip) - (toInt(ip) % size);
  return start === toInt(ip) ? undefined : `${v} isn't the start of its range; use ${toIp(start)}/${bits}`;
}

/** A value a setting's `pattern` doesn't take, or undefined. */
export function patternProblem(value: unknown, pattern: string | undefined): string | undefined {
  if (!pattern || typeof value !== "string" || value === "" || value.includes("{{")) return undefined;
  try {
    return new RegExp(pattern).test(value) ? undefined : `${value} isn't in the form this takes`;
  } catch {
    return undefined;
  }
}

/** What's wrong with a [first, last] range of addresses, or undefined. */
export function rangeProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const [first, last] = value as unknown[];
  if (!first || !last) return value.some(Boolean) ? "needs a first and a last address" : undefined;
  const bad = addressProblem(first, "ip") ?? addressProblem(last, "ip");
  if (bad) return bad;
  return toInt(String(first)) > toInt(String(last)) ? "the first address is after the last" : undefined;
}

/** What's wrong with a list of addresses, or undefined. */
export const listProblem = (value: unknown, format?: AddressFormat, pattern?: string) =>
  Array.isArray(value) ? value.map(v => (format && addressProblem(v, format)) || patternProblem(v, pattern)).find(Boolean) : undefined;
