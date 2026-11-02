// Downstream clusters: what every cluster shares (its Rancher) here, the rest by its type's module
// (clusters/); then the ChartProfiles and Profiles on them.

import { reachesRancherOverInternet, resolveCluster, type ClusterContext } from "../clusters";
import { blocksMetalClusterNode, checkClusterProfiles, clusterCapabilities, hostCapabilities, profileBuildOrder } from "../profiles/rules";
import { profileTargets } from "../profiles/define";
import type { ResolvedClusterProfiles } from "../resolve";
import type { Credentials } from "../schema";
import type { Resolution } from "./context";

/** The lab's downstream clusters, each by its type. */
export function resolveDownstream(r: Resolution): void {
    const { lab, L, diags, registry, hosts, harvesters, awsSites, downstream, vmDefaults, awsDefaults, useOs, needImage, checkNetwork, describe } = r;
    const clusterContext: ClusterContext = {
        error: (path, message) => diags.error(L, path, message),
        inputs: lab.downstream,
        hosts,
        harvesters,
        awsSites,
        defaults: { vm: vmDefaults, aws: awsDefaults },
        useOs,
        needImage,
        checkNetwork,
        metalNodeOwner: new Map(),
        blocksMetalNode: host => blocksMetalClusterNode(registry, host.profiles),
    };
    for (const [name, d] of Object.entries(lab.downstream)) {
        const at = `downstream.${name}`;
        const rancher = hosts.get(d.rancher);
        const rancherCaps = rancher ? hostCapabilities(registry, rancher.profiles) : undefined;
        const overInternet = reachesRancherOverInternet(d.type);
        if (!rancher) diags.error(L, `${at}.rancher`, `unknown host "${d.rancher}"`);
        else if (!rancherCaps!.has("rancher")) diags.error(L, `${at}.rancher`, `host "${d.rancher}" doesn't run rancher`);
        // Machines on AWS register with Rancher over the internet.
        else if (overInternet && !rancherCaps!.has("public-ingress")) {
            diags.error(L, `${at}.rancher`, `${overInternet} Rancher over the internet, and the Rancher on ${d.rancher} isn't public: its host needs ${describe("public-ingress")}`);
        }
        downstream.push(resolveCluster(clusterContext, name, d, at));
    }
}

/** Downstream clusters' profiles: checked, ordered, their charts' values rendered. */
export function resolveClusterProfiles(r: Resolution): void {
    const { lab, L, diags, catalog, registry, downstream, forTarget, parseProfiles, renderProfile, useCredentials, useSecretOrString, useTemplate } = r;
    for (const d of downstream) {
        const asked = Object.entries(d.profiles ?? {});
        if (asked.length === 0) continue;
        const at = `downstream.${d.name}`;
        const clusterProfiles = forTarget("cluster");
        const own: Record<string, Record<string, unknown>> = {};
        for (const [n, settings] of asked) {
            const def = registry[n];
            if (def && profileTargets(def).includes("cluster")) own[n] = settings;
            else if (def) diags.error(L, `${at}.profiles.${n}`, `is a Profile for lab hosts (the engine has code for it); a downstream cluster takes: ${clusterProfiles.join(", ")}`);
            else if (catalog.fleet.profiles[n]) diags.error(L, `${at}.profiles.${n}`, `is a Fleet profile: list it under fleetProfiles`);
            else diags.error(L, `${at}.profiles.${n}`, `unknown profile "${n}"; a downstream cluster takes: ${clusterProfiles.join(", ")}`);
        }
        const profiles = parseProfiles(own, at);
        checkClusterProfiles({
            registry,
            cluster: { name: d.name, profiles },
            error: (path, message) => diags.error(L, path, message),
            secretField: (value, path, shape) => {
                if (value === undefined) return;
                if (shape === "credentials") useCredentials(value as Credentials, L, path);
                else useSecretOrString(value as string, L, path);
            },
            secretTemplate: (template, path) => useTemplate(template, "string", L, path),
        });
        // Outputs only from the profile providing each capability, as on a host.
        const caps = clusterCapabilities(registry, profiles);
        const outputs: Record<string, Record<string, unknown>> = {};
        for (const n of Object.keys(profiles)) {
            for (const [cap, o] of Object.entries(registry[n]?.outputs ?? {})) if (caps.get(cap)?.includes(n)) outputs[cap] = o;
        }
        const target = { kind: "cluster" as const, name: d.name, fqdn: `${d.name}.${lab.domain}` };
        const chartValues: ResolvedClusterProfiles["chartValues"] = {};
        for (const n of Object.keys(profiles)) {
            const rendered = renderProfile(n, profiles, outputs, { target }, `cluster ${d.name}`);
            if (rendered) chartValues[n] = rendered;
        }
        d.chartProfiles = { profiles, order: diags.ok ? profileBuildOrder(registry, profiles) : Object.keys(profiles), chartValues };
    }
}
