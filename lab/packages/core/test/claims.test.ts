import { describe, expect, it } from "vitest";
import { checkSite, claim, claimSite, ClaimStore, Owner, OwnershipConflict, release, releaseSite, singleClaimStore } from "../src";

/** A site's claims in memory, one per lab like a shared site keeps them. */
class MemoryClaims implements ClaimStore {
    constructor(public claims: Owner[] = [], private raceWinner?: Owner) {}
    async list() { return [...this.claims]; }
    async create(owner: Owner) {
        if (this.raceWinner) {
            this.claims.push(this.raceWinner);
            this.raceWinner = undefined;
            return false;
        }
        if (this.claims.some(c => c.lab === owner.lab)) return false;
        this.claims.push(owner);
        return true;
    }
    async delete(lab: string) { this.claims = this.claims.filter(c => c.lab !== lab); }
}

const me: Owner = { lab: "demo", user: "jeroen@example.com" };
const other: Owner = { lab: "mlm", user: "someone@example.com", claimedAt: "2026-10-01T10:00:00.000Z" };
const sameLabOtherUser: Owner = { lab: "demo", user: "someone@example.com" };
const NOW = new Date("2026-10-22T12:00:00Z");

describe("claimSite on a shared site", () => {
    it("lets two labs use the site at once", async () => {
        const store = new MemoryClaims([other]);
        expect(await claimSite("kvm", store, me, "shared", NOW)).toBe("claimed");
        expect(store.claims.map(c => c.lab)).toEqual(["mlm", "demo"]);
        expect(store.claims[1]).toEqual({ ...me, claimedAt: "2026-10-22T12:00:00.000Z" });
    });

    it("is idempotent for the same lab and user", async () => {
        const store = new MemoryClaims([{ ...me, claimedAt: "x" }, other]);
        expect(await claimSite("kvm", store, me, "shared")).toBe("already-ours");
        expect(store.claims).toHaveLength(2);
    });

    it("refuses the same lab name run by someone else, even when sharing", async () => {
        await expect(claimSite("kvm", new MemoryClaims([sameLabOtherUser]), me, "shared")).rejects.toBeInstanceOf(OwnershipConflict);
    });

    it("handles losing a race against the same lab run by someone else", async () => {
        await expect(claimSite("kvm", new MemoryClaims([], sameLabOtherUser), me, "shared")).rejects.toBeInstanceOf(OwnershipConflict);
    });

    it("a lost race against a different lab is not a conflict: it claims again", async () => {
        const store = new MemoryClaims([], other);
        // The first create "fails" because another lab's claim appeared; ours can still be made.
        expect(await claimSite("kvm", store, me, "shared")).toBe("claimed");
        expect(store.claims.map(c => c.lab).sort()).toEqual(["demo", "mlm"]);
    });
});

describe("claimSite on an exclusive site", () => {
    it("refuses a site another lab uses and names the owner", async () => {
        await expect(claimSite("hv", new MemoryClaims([other]), me, "exclusive")).rejects.toThrow(/in use by lab "mlm" \(someone@example.com, since 2026-10-01/);
    });

    it("claims a free site", async () => {
        const store = new MemoryClaims();
        expect(await claimSite("hv", store, me, "exclusive", NOW)).toBe("claimed");
        expect(store.claims).toEqual([{ ...me, claimedAt: "2026-10-22T12:00:00.000Z" }]);
    });

    it("handles losing a race", async () => {
        await expect(claimSite("hv", new MemoryClaims([], other), me, "exclusive")).rejects.toBeInstanceOf(OwnershipConflict);
    });
});

describe("claimSite messages", () => {
    it("names the kind of site", async () => {
        await expect(claimSite("nuc", new MemoryClaims([other]), me, "exclusive", NOW, "libvirt site")).rejects.toThrow(/^libvirt site "nuc" is in use by lab "mlm"/);
    });
});

describe("checkSite", () => {
    it("says a site nobody claimed is free, and one we claimed is ours", async () => {
        expect(await checkSite("hv", new MemoryClaims(), me, "exclusive")).toBe("free");
        expect(await checkSite("hv", new MemoryClaims([me]), me, "exclusive")).toBe("ours");
    });

    it("refuses a site another lab holds when exclusive, and says who", async () => {
        await expect(checkSite("hv", new MemoryClaims([other]), me, "exclusive")).rejects.toThrow(/in use by lab "mlm"/);
    });

    it("lets a shared site be used next to other labs, but not by the same lab name under someone else", async () => {
        expect(await checkSite("kvm", new MemoryClaims([other]), me, "shared")).toBe("free");
        await expect(checkSite("kvm", new MemoryClaims([sameLabOtherUser]), me, "shared")).rejects.toBeInstanceOf(OwnershipConflict);
    });

    it("changes nothing", async () => {
        const store = new MemoryClaims([other]);
        await checkSite("kvm", store, me, "shared");
        expect(store.claims).toEqual([other]);
    });
});

describe("releaseSite", () => {
    it("removes only our claim on a shared site, leaving the other labs'", async () => {
        const store = new MemoryClaims([other, me]);
        expect(await releaseSite("kvm", store, me, "shared")).toBe("released");
        expect(store.claims).toEqual([other]);
    });

    it("on a shared site, another lab's claim is none of our business", async () => {
        const store = new MemoryClaims([other]);
        expect(await releaseSite("kvm", store, me, "shared")).toBe("not-claimed");
        expect(store.claims).toEqual([other]);
    });

    it("refuses the same lab name claimed by someone else unless forced", async () => {
        const store = new MemoryClaims([sameLabOtherUser]);
        await expect(releaseSite("kvm", store, me, "shared")).rejects.toBeInstanceOf(OwnershipConflict);
        expect(await releaseSite("kvm", store, me, "shared", true)).toBe("released");
        expect(store.claims).toEqual([]);
    });

    it("on an exclusive site, another lab's claim stops the release unless forced", async () => {
        const store = new MemoryClaims([other]);
        await expect(releaseSite("hv", store, me, "exclusive")).rejects.toBeInstanceOf(OwnershipConflict);
        expect(await releaseSite("hv", store, me, "exclusive", true)).toBe("released");
        expect(store.claims).toEqual([]);
    });

    it("is fine when nothing is claimed", async () => {
        expect(await releaseSite("hv", new MemoryClaims(), me, "exclusive")).toBe("not-claimed");
    });
});

describe("a site with a single claim (a Harvester's)", () => {
    class SingleStore {
        constructor(public owner?: Owner) {}
        async get() { return this.owner; }
        async create(o: Owner) { if (this.owner) return false; this.owner = o; return true; }
        async delete() { this.owner = undefined; }
    }

    it("is a store of at most one claim", async () => {
        const store = singleClaimStore(new SingleStore());
        expect(await store.list()).toEqual([]);
        expect(await store.create(me)).toBe(true);
        expect(await store.list()).toEqual([me]);
        expect(await store.create(other)).toBe(false);
        await store.delete("demo");
        expect(await store.list()).toEqual([]);
    });

    it("claim and release are the exclusive case of claimSite and releaseSite", async () => {
        const inner = new SingleStore();
        expect(await claim("hv", inner, me, NOW)).toBe("claimed");
        await expect(claim("hv", inner, other)).rejects.toThrow(/harvester "hv" is in use by lab "demo"/);
        expect(await release("hv", inner, me)).toBe("released");
        expect(inner.owner).toBeUndefined();
    });
});
