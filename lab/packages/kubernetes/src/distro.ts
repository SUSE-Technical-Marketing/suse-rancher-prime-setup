import type { ResolvedDistribution } from "@lab/schema";
import { stringify } from "yaml";

export type Distro = "k3s" | "rke2";

export interface DistroInstall {
    /** cloud-init `runcmd` lines that install and start the distribution. */
    runcmd: string[];
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface DistroOptions {
    /**
     * The capabilities other profiles on the host provide (`load-balancer`, `cloud-provider`):
     * the distribution's `withCapability` config for each is merged in, in its document's order.
     */
    capabilities?: string[];
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Distribution config layers: maps merge key by key, lists are joined (`disable: [traefik]` + `[servicelb]`). */
export function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
        const old = out[key];
        out[key] = Array.isArray(value) && Array.isArray(old) ? [...new Set([...old, ...value])]
            : isMap(value) && isMap(old) ? mergeConfig(old, value)
            : value;
    }
    return out;
}

/**
 * Install a single-node k3s or RKE2 server as its KubernetesDistribution document says (DESIGN.md
 * §16.2): its config file with the host's FQDN as a tls-san, so the kubeconfig works by name as
 * well as by address, then its install command (already rendered with the version).
 */
export function distroInstall(d: ResolvedDistribution, install: string, fqdn: string, opts: DistroOptions = {}): DistroInstall {
    const others = new Set(opts.capabilities ?? []);
    const config = mergeConfig(
        Object.entries(d.withCapability).filter(([cap]) => others.has(cap)).reduce((c, [, over]) => mergeConfig(c, over), d.config),
        { "tls-san": [fqdn] },
    );
    const dir = d.configFile.replace(/\/[^/]*$/, "") || "/";
    return {
        runcmd: [
            `mkdir -p ${quote(dir)}`,
            `printf '%s' ${quote(stringify(config))} > ${quote(d.configFile)}`,
            install,
        ],
    };
}

/** A command on the host that succeeds once the API server answers. */
export const readyCheck = (d: Pick<ResolvedDistribution, "kubectl">) => `sudo ${d.kubectl} get --raw /readyz`;
