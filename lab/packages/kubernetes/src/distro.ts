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

/**
 * A command (run as root) that starts a watcher on a k3s or RKE2 server for its first
 * `forSeconds`. The distribution's helm-controller suspends an install Job before replacing it,
 * and sometimes never deletes it; that chart is then never installed (a missing cloud provider
 * keeps the node tainted). The watcher deletes helm-controller Jobs that stay suspended for 90s,
 * and helm-controller makes them again. It runs as the transient unit `lab-helm-watch`, so the
 * command returns at once (one already running is replaced); its log is `journalctl -u lab-helm-watch`.
 */
export function helmJobWatch(d: Pick<ResolvedDistribution, "kubeconfig" | "kubectl">, forSeconds: number): string {
    const jobs = `{range .items[?(@.spec.suspend==true)]}{.metadata.namespace}/{.metadata.name}/{.metadata.uid}{" "}{end}`;
    const script = [
        `end=$(($(date +%s)+${forSeconds})); seen=/run/lab-helm-watch; mkdir -p $seen`,
        `while [ $(date +%s) -lt $end ]; do`,
        `if [ -f ${quote(d.kubeconfig)} ]; then`,
        `for j in $(${d.kubectl} get jobs -A -l helmcharts.helm.cattle.io/chart -o jsonpath=${quote(jobs)} 2>/dev/null); do`,
        `f=$seen/\${j##*/}; [ -f $f ] || touch $f`,
        `if [ $(($(date +%s)-$(stat -c %Y $f))) -ge 90 ]; then ns=\${j%%/*}; job=\${j#*/}; job=\${job%/*}; echo "deleting job $ns/$job, suspended for 90s"; ${d.kubectl} -n $ns delete job $job --ignore-not-found; fi`,
        `done; fi; sleep 15; done`,
    ].join("; ").replace(/(do|then);/g, "$1");
    // systemd expands $VAR and ${VAR} in a unit's command line itself; $$ passes a `$` on to sh.
    const forSystemd = script.replace(/\$/g, "$$$$");
    return `{ { systemctl stop lab-helm-watch; systemctl reset-failed lab-helm-watch; } 2>/dev/null; systemd-run --unit=lab-helm-watch --description='Delete stuck helm-controller Jobs' sh -c ${quote(forSystemd)}; }`;
}

/** A command on the host that succeeds once the API server answers. */
export const readyCheck = (d: Pick<ResolvedDistribution, "kubectl">) => `sudo ${d.kubectl} get --raw /readyz`;
