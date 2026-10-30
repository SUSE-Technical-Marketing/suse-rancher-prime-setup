import { HarvesterApi } from "./harvester-api";

/** Who has a Harvester: one lab, run by one person, at a time (DESIGN.md §10). */
export interface Owner {
    lab: string;
    user: string;
    claimedAt?: string;
}

/** Where the claim is stored. On a Harvester that's a ConfigMap; tests use an in-memory store. */
export interface OwnerStore {
    get(): Promise<Owner | undefined>;
    /** Create the claim. Returns false if someone else created one first. */
    create(owner: Owner): Promise<boolean>;
    delete(): Promise<void>;
}

export class OwnershipConflict extends Error {
    constructor(readonly harvester: string, readonly owner: Owner) {
        super(
            `harvester "${harvester}" is in use by lab "${owner.lab}" (${owner.user}` +
            `${owner.claimedAt ? `, since ${owner.claimedAt}` : ""}). ` +
            `Ask them to run "lab destroy", or use "lab release" if that lab no longer exists.`,
        );
    }
}

const sameOwner = (a: Owner, b: Owner) => a.lab === b.lab && a.user === b.user;

/** Claim a Harvester for this lab. Idempotent for the same lab and user. */
export async function claim(harvester: string, store: OwnerStore, me: Owner, now = new Date()): Promise<"claimed" | "already-ours"> {
    const current = await store.get();
    if (current) {
        if (sameOwner(current, me)) return "already-ours";
        throw new OwnershipConflict(harvester, current);
    }
    if (await store.create({ ...me, claimedAt: now.toISOString() })) return "claimed";
    // Lost a race with someone else claiming it at the same moment.
    const winner = await store.get();
    if (winner && sameOwner(winner, me)) return "already-ours";
    throw new OwnershipConflict(harvester, winner ?? { lab: "unknown", user: "unknown" });
}

/** Release a claim. Only the owner may release it, unless `force` is set. */
export async function release(harvester: string, store: OwnerStore, me: Owner, force = false): Promise<"released" | "not-claimed"> {
    const current = await store.get();
    if (!current) return "not-claimed";
    if (!sameOwner(current, me) && !force) throw new OwnershipConflict(harvester, current);
    await store.delete();
    return "released";
}

const CONFIGMAP_PATH = "/api/v1/namespaces/default/configmaps";
const CONFIGMAP_NAME = "lab-owner";

/** The claim as a `lab-owner` ConfigMap in the Harvester's `default` namespace. */
export class HarvesterOwnerStore implements OwnerStore {
    constructor(private readonly api: HarvesterApi) {}

    async get(): Promise<Owner | undefined> {
        const res = await this.api.k8s("GET", `${CONFIGMAP_PATH}/${CONFIGMAP_NAME}`);
        if (res.status === 404) return undefined;
        if (res.status !== 200) throw new Error(`reading ${CONFIGMAP_NAME} on ${this.api.url} failed: HTTP ${res.status}`);
        const data = res.body?.data ?? {};
        return { lab: data.lab ?? "unknown", user: data.user ?? "unknown", claimedAt: data.claimedAt };
    }

    async create(owner: Owner): Promise<boolean> {
        const res = await this.api.k8s("POST", CONFIGMAP_PATH, {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: CONFIGMAP_NAME, labels: { "app.kubernetes.io/managed-by": "lab" } },
            data: { lab: owner.lab, user: owner.user, claimedAt: owner.claimedAt ?? "" },
        });
        if (res.status === 409) return false;
        if (res.status !== 201 && res.status !== 200) throw new Error(`creating ${CONFIGMAP_NAME} on ${this.api.url} failed: HTTP ${res.status}`);
        return true;
    }

    async delete(): Promise<void> {
        const res = await this.api.k8s("DELETE", `${CONFIGMAP_PATH}/${CONFIGMAP_NAME}`);
        if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
            throw new Error(`deleting ${CONFIGMAP_NAME} on ${this.api.url} failed: HTTP ${res.status}`);
        }
    }
}
