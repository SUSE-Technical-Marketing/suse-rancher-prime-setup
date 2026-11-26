// Who uses a site (DESIGN.md §10, §18.3). A site holds one claim per lab that uses it, each tied to
// the user who runs that lab. Whether claims of different labs may coexist is the site's `sharing`:
// a Harvester is `exclusive` (its add-ons and default storage class belong to one lab), an AWS or
// libvirt site is `shared` (everything a lab makes there is its own: a VPC, domains, tags).
//
// In both, the same lab name run by someone else is refused: two people building "demo" on one site
// would be building one lab.

/** Who has a claim on a site: one lab, run by one person. */
export interface Owner {
    lab: string;
    user: string;
    claimedAt?: string;
}

/** Whether labs may use a site at once. */
export type Sharing = "exclusive" | "shared";

/** Where a site's claims are stored: a ConfigMap on a Harvester, an in-memory list in tests. */
export interface ClaimStore {
    list(): Promise<Owner[]>;
    /** Create the lab's claim. Returns false if a claim for that lab (or, on an exclusive site, any claim) was created first. */
    create(owner: Owner): Promise<boolean>;
    /** Remove the claim of a lab. */
    delete(lab: string): Promise<void>;
}

/** Where a site with a single claim stores it: a ConfigMap on a Harvester. */
export interface OwnerStore {
    get(): Promise<Owner | undefined>;
    /** Create the claim. Returns false if someone else created one first. */
    create(owner: Owner): Promise<boolean>;
    delete(): Promise<void>;
}

/** A store of one claim as a store of claims: at most one in the list. */
export function singleClaimStore(store: OwnerStore): ClaimStore {
    return {
        list: async () => {
            const owner = await store.get();
            return owner ? [owner] : [];
        },
        create: owner => store.create(owner),
        delete: () => store.delete(),
    };
}

export class OwnershipConflict extends Error {
    /** `what` is how the site is named in the message: "harvester" by default. */
    constructor(readonly harvester: string, readonly owner: Owner, what = "harvester") {
        super(
            `${what} "${harvester}" is in use by lab "${owner.lab}" (${owner.user}` +
            `${owner.claimedAt ? `, since ${owner.claimedAt}` : ""}). ` +
            `Ask them to run "lab destroy", or use "lab release" if that lab no longer exists.`,
        );
    }
}

const sameOwner = (a: Owner, b: Owner) => a.lab === b.lab && a.user === b.user;

/** The claim that stops `me` from claiming a site, if any. */
function blocker(claims: Owner[], me: Owner, sharing: Sharing): Owner | undefined {
    return claims.find(c => !sameOwner(c, me) && (sharing === "exclusive" || c.lab === me.lab));
}

/** Read-only: whether this lab could claim the site. Throws `OwnershipConflict` if another claim stops it. */
export async function checkSite(site: string, store: ClaimStore, me: Owner, sharing: Sharing, what = "harvester"): Promise<"free" | "ours"> {
    const claims = await store.list();
    const other = blocker(claims, me, sharing);
    if (other) throw new OwnershipConflict(site, other, what);
    return claims.some(c => sameOwner(c, me)) ? "ours" : "free";
}

/** Claim a site for this lab. Idempotent for the same lab and user. */
export async function claimSite(site: string, store: ClaimStore, me: Owner, sharing: Sharing, now = new Date(), what = "harvester"): Promise<"claimed" | "already-ours"> {
    const check = async (): Promise<"already-ours" | undefined> => {
        const claims = await store.list();
        const other = blocker(claims, me, sharing);
        if (other) throw new OwnershipConflict(site, other, what);
        return claims.some(c => sameOwner(c, me)) ? "already-ours" : undefined;
    };
    // A create that fails means a claim appeared at the same moment: look again. If it is ours, or one
    // that blocks us, that settles it; if it is another lab's on a shared site, ours can still be made.
    for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await check();
        if (existing) return existing;
        if (await store.create({ ...me, claimedAt: now.toISOString() })) return "claimed";
    }
    throw new OwnershipConflict(site, { lab: "unknown", user: "unknown" }, what);
}

/**
 * Release this lab's claim on a site. Only its owner may, unless `force` is set. On an exclusive
 * site another lab's claim also stops the release (it is not ours to remove), on a shared one it
 * doesn't matter: only our own claim is looked at.
 */
export async function releaseSite(site: string, store: ClaimStore, me: Owner, sharing: Sharing, force = false, what = "harvester"): Promise<"released" | "not-claimed"> {
    const claims = await store.list();
    const mine = claims.find(c => c.lab === me.lab);
    if (!mine) {
        const other = sharing === "exclusive" ? claims[0] : undefined;
        if (!other) return "not-claimed";
        if (!force) throw new OwnershipConflict(site, other, what);
        await store.delete(other.lab);
        return "released";
    }
    if (!sameOwner(mine, me) && !force) throw new OwnershipConflict(site, mine, what);
    await store.delete(mine.lab);
    return "released";
}

/** Claim a Harvester (one claim, exclusive) for this lab. Idempotent for the same lab and user. */
export function claim(harvester: string, store: OwnerStore, me: Owner, now = new Date()): Promise<"claimed" | "already-ours"> {
    return claimSite(harvester, singleClaimStore(store), me, "exclusive", now);
}

/** Release a Harvester's claim. Only the owner may release it, unless `force` is set. */
export function release(harvester: string, store: OwnerStore, me: Owner, force = false): Promise<"released" | "not-claimed"> {
    return releaseSite(harvester, singleClaimStore(store), me, "exclusive", force);
}
