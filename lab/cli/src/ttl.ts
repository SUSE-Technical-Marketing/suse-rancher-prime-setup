// A lab with a `ttl` is meant to live that long from when it was first created (the stack's
// `lab:createdAt`, set by the first `up` and kept). `lab reap` destroys the labs past it.

export interface Expiry {
    /** When the lab expires; undefined for a lab without a ttl. */
    at?: Date;
    expired: boolean;
}

/** The expiry of a lab created at `createdAt` with `ttlSeconds`; none without both. */
export function expiryOf(createdAt: string | undefined, ttlSeconds: number | undefined, now = new Date()): Expiry {
    if (!ttlSeconds || !createdAt) return { expired: false };
    const created = Date.parse(createdAt);
    if (Number.isNaN(created)) return { expired: false };
    const at = new Date(created + ttlSeconds * 1000);
    return { at, expired: at.getTime() <= now.getTime() };
}

/** "in 3h 20m" or "2h ago": how far `at` is from `now`, to the minute. */
export function relative(at: Date, now = new Date()): string {
    const minutes = Math.round(Math.abs(at.getTime() - now.getTime()) / 60000);
    const text = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
    return at.getTime() <= now.getTime() ? `${text} ago` : `in ${text}`;
}

export type ReapDecision = "expired" | "alive" | "no-ttl" | "no-lab";

/** What `lab reap` does with a lab: `createdAt` is undefined when the lab has no stack. */
export function reapDecision(ttlSeconds: number | undefined, stackExists: boolean, createdAt: string | undefined, now = new Date()): ReapDecision {
    if (!ttlSeconds) return "no-ttl";
    if (!stackExists) return "no-lab";
    return expiryOf(createdAt, ttlSeconds, now).expired ? "expired" : "alive";
}
