// The lab's catalog secrets and configmaps (DESIGN.md §16.6): created from the catalog and the
// inputs, then placed on the hosts and downstream clusters that ask for them.

import { createObjects, placementOf, type ObjectTarget, type Placement } from "../objects";
import { hostCapabilities } from "../profiles/rules";
import type { Credentials } from "../schema";
import type { Resolution } from "./context";

/** The lab's secrets and configmaps from the catalog and the inputs. */
export function createLabObjects(r: Resolution): void {
    const { lab, L, P, personal, diags, catalog, useCredentials, useSecretOrString, describe } = r;
    r.objects = createObjects({
        catalog: { secrets: catalog.secrets, configmaps: catalog.configmaps },
        inputs: [{ values: personal.inputs, source: P, at: "inputs" }, { values: lab.inputs, source: L, at: "inputs" }],
        lab: { "tls.email": lab.tls.email, "tls.cloudflare": lab.tls.cloudflare, domain: lab.domain },
        diags,
        useSecret: (value, shape, source, valueAt) => shape === "credentials"
            ? useCredentials(value as Credentials, source, valueAt)
            : useSecretOrString(value as string, source, valueAt),
        describeCapability: describe,
    });
}

/** The hosts' and downstream clusters' `secrets:` and `configmaps:`. */
export function placeLabObjects(r: Resolution): void {
    const { lab, L, diags, registry, hosts, downstream, objects, describe } = r;
    /** Place a host's or downstream cluster's `secrets:` and `configmaps:` lists. */
    const placeAll = (target: ObjectTarget, lists: { secrets?: Placement[]; configmaps?: Placement[] }, at: string, capabilities?: { has(c: string): boolean }) => {
        for (const [kind, key] of [["Secret", "secrets"], ["ConfigMap", "configmaps"]] as const) {
            (lists[key] ?? []).forEach((p, i) => {
                const { name, namespace } = placementOf(p);
                objects.place(kind, name, { target, capabilities, namespace, required: true, source: L, at: `${at}.${key}[${i}]` });
            });
        }
    };

    for (const host of hosts.values()) {
        const input = lab.hosts[host.name];
        if (!input?.secrets?.length && !input?.configmaps?.length) continue;
        const caps = hostCapabilities(registry, host.profiles);
        const at = `hosts.${host.name}`;
        if (!caps.has("kubernetes")) {
            diags.error(L, at, `has secrets or configmaps to create, but no ${describe("kubernetes")} to put them on`);
            continue;
        }
        placeAll({ host: host.name }, input, at, caps);
    }
    for (const d of downstream) placeAll({ downstream: d.name }, d, `downstream.${d.name}`);
}
