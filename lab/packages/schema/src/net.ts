// IPv4 helpers for the resolver's address checks.

export const toInt = (ip: string) => ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
const toIp = (n: number) => [24, 16, 8, 0].map(shift => Math.floor(n / 2 ** shift) % 256).join(".");

/** The n-th address of a CIDR, e.g. nthAddress("10.29.20.0/24", 2) = "10.29.20.2". */
export function nthAddress(cidr: string, n: number): string {
    const [base, bits] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    return toIp(toInt(base) - (toInt(base) % size) + n);
}

export function inCidr(ip: string, cidr: string): boolean {
    const [base, bits] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    const start = toInt(base) - (toInt(base) % size);
    return toInt(ip) >= start && toInt(ip) < start + size;
}
