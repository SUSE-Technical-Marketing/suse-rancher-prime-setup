import { describe, expect, it } from "vitest";
import { claim, isSupportedHarvesterVersion, Owner, OwnerStore, OwnershipConflict, release } from "../src";

class MemoryStore implements OwnerStore {
    constructor(public owner?: Owner, private raceWinner?: Owner) {}
    async get() { return this.owner; }
    async create(owner: Owner) {
        if (this.raceWinner) {
            this.owner = this.raceWinner;
            return false;
        }
        this.owner = owner;
        return true;
    }
    async delete() { this.owner = undefined; }
}

const me: Owner = { lab: "demo", user: "jeroen@example.com" };
const other: Owner = { lab: "mlm", user: "someone@example.com", claimedAt: "2026-10-01T10:00:00.000Z" };

describe("claim", () => {
    it("claims a free Harvester", async () => {
        const store = new MemoryStore();
        expect(await claim("hv", store, me, new Date("2026-10-22T12:00:00Z"))).toBe("claimed");
        expect(store.owner).toEqual({ ...me, claimedAt: "2026-10-22T12:00:00.000Z" });
    });

    it("is idempotent for the same lab and user", async () => {
        expect(await claim("hv", new MemoryStore({ ...me, claimedAt: "x" }), me)).toBe("already-ours");
    });

    it("refuses a Harvester owned by another lab and names the owner", async () => {
        await expect(claim("hv", new MemoryStore(other), me)).rejects.toThrow(/in use by lab "mlm" \(someone@example.com, since 2026-10-01/);
    });

    it("refuses the same lab name run by someone else", async () => {
        await expect(claim("hv", new MemoryStore({ lab: "demo", user: "someone@example.com" }), me)).rejects.toBeInstanceOf(OwnershipConflict);
    });

    it("handles losing a race", async () => {
        await expect(claim("hv", new MemoryStore(undefined, other), me)).rejects.toBeInstanceOf(OwnershipConflict);
    });
});

describe("release", () => {
    it("releases our own claim", async () => {
        const store = new MemoryStore(me);
        expect(await release("hv", store, me)).toBe("released");
        expect(store.owner).toBeUndefined();
    });

    it("refuses someone else's claim unless forced", async () => {
        const store = new MemoryStore(other);
        await expect(release("hv", store, me)).rejects.toBeInstanceOf(OwnershipConflict);
        expect(await release("hv", store, me, true)).toBe("released");
    });

    it("is fine when nothing is claimed", async () => {
        expect(await release("hv", new MemoryStore(), me)).toBe("not-claimed");
    });
});

describe("isSupportedHarvesterVersion", () => {
    it.each([
        ["v1.9.0", true],
        ["v1.8.0-rc1", true],
        ["1.10.2", true],
        ["v2.0.0", true],
        ["v1.7.1", false],
        ["master-abc123", undefined],
    ])("%s -> %s", (version, expected) => {
        expect(isSupportedHarvesterVersion(version)).toBe(expected);
    });
});
