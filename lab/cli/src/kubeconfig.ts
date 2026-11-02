import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";

// One kubeconfig for a lab's clusters (DESIGN.md §10): written next to the lab file after `up`,
// one context per cluster the lab provisioned (its hosts' k3s / RKE2, its downstream clusters), named
// after it. Where it goes from there is up to the user.

/** Where a lab's kubeconfig goes: next to its lab file, `<lab>.kubeconfig`. */
export const kubeconfigPath = (labFile: string, lab: string) => path.join(path.dirname(path.resolve(labFile)), `${lab}.kubeconfig`);

interface Named<T> { name: string; [key: string]: unknown; cluster?: T; user?: T; context?: T }

/**
 * Merge kubeconfigs (JSON or YAML, one cluster each), by cluster name, into one: each cluster's
 * context, cluster and user take its name. The current context is `current`, or the first.
 */
export function mergeKubeconfigs(configs: Record<string, string>, current?: string): string {
    const names = Object.keys(configs).sort();
    const merged = { apiVersion: "v1", kind: "Config", clusters: [] as Named<unknown>[], users: [] as Named<unknown>[], contexts: [] as Named<unknown>[], "current-context": "" };
    for (const name of names) {
        const kc = parse(configs[name]) as { clusters?: Named<unknown>[]; users?: Named<unknown>[]; contexts?: Named<unknown>[]; "current-context"?: string };
        const context = kc.contexts?.find(c => c.name === kc["current-context"]) ?? kc.contexts?.[0];
        const ctx = context?.context as { cluster?: string; user?: string; namespace?: string } | undefined;
        const cluster = kc.clusters?.find(c => c.name === ctx?.cluster) ?? kc.clusters?.[0];
        const user = kc.users?.find(u => u.name === ctx?.user) ?? kc.users?.[0];
        if (!cluster || !user) throw new Error(`the kubeconfig of ${name} has no cluster or user`);
        merged.clusters.push({ name, cluster: cluster.cluster });
        merged.users.push({ name, user: user.user });
        merged.contexts.push({ name, context: { cluster: name, user: name, ...(ctx?.namespace ? { namespace: ctx.namespace } : {}) } });
    }
    merged["current-context"] = current && names.includes(current) ? current : names[0] ?? "";
    return stringify(merged, { lineWidth: 0 });
}

/** Write it, readable by its owner only (it holds the clusters' credentials). */
export function writeKubeconfig(file: string, text: string): void {
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}
