import { HarvesterApi } from "./harvester-api";
import type { Owner, OwnerStore } from "./claims";

// Who has a Harvester (DESIGN.md §10): the claim logic is in claims.ts, shared with the other kinds
// of site; this is where a Harvester keeps it.
export { claim, release, OwnershipConflict, type Owner, type OwnerStore } from "./claims";

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
