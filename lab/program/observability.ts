import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { AGENT_SECRET, agentValues, ObservabilityAgent, ObservabilityRegistration } from "@lab/apps";
import { HarvesterAddon } from "@lab/harvester";
import type { ClusterAccess } from "@lab/kubernetes";
import type { ResolvedLab } from "@lab/schema";
import type { ProfileSettings } from "./generated/profile-settings";
import { chartInNamespace } from "./catalog";
import { chartValuesWithSecrets, secretString } from "./secrets";

// SUSE Observability agents (DESIGN.md §9.6), on lab hosts, downstream clusters and Harvesters: built
// last, once the clusters they report to exist. Each is registered with its observer (a downstream
// cluster whose Fleet profiles run SUSE Observability) through its API, then installed with the
// service token that gives it.

export const AGENT = "suse-observability-agent";
type AgentSettings = ProfileSettings["suse-observability-agent"];

/** A cluster the agents can go on, or report to: what to install with, and when it's there. */
export type AgentCluster = Pick<ClusterAccess, "provider" | "deletedWith"> & { ready: pulumi.Resource[] };

export interface AgentTargets {
    /** Lab hosts' clusters, by host. */
    hosts: Record<string, AgentCluster>;
    /** Downstream clusters, by name. */
    downstream: Record<string, AgentCluster>;
    /** Harvesters' own clusters, by name. */
    harvesters: Record<string, { provider: k8s.Provider; ready: pulumi.Resource[] }>;
    /** Each Rancher host's Fleet HelmOps and GitRepos: an observer's SUSE Observability, and its token, come from them. */
    fleet: Record<string, pulumi.Resource[]>;
}

/** Register and install every agent the lab has. */
export function buildObservabilityAgents(lab: ResolvedLab, targets: AgentTargets): void {
    const register = (prefix: string, s: AgentSettings, clusterName: string, virtualization = false) => {
        // The resolver checked the observer is a downstream cluster whose Fleet profiles provide it.
        const observer = lab.downstream.find(d => d.name === s.observer)!;
        const url = observer.fleetOutputs!["suse-observability"].url;
        const registration = new ObservabilityRegistration(`${prefix}/${AGENT}/registration`, {
            url,
            adminToken: secretString(s.adminToken),
            subject: `agent-${clusterName}`,
            clusterName,
            ...(virtualization ? { virtualization } : {}),
            insecure: !!lab.acme?.ca,
            timeoutSeconds: lab.timeouts.observabilityReady,
            // After its cluster, and after its Rancher's Fleet HelmOps: a new admin token reaches the
            // instance with them.
        }, { dependsOn: [...(targets.downstream[observer.name]?.ready ?? []), ...(targets.fleet[observer.rancher] ?? [])] });
        return { url, registration };
    };
    const kubernetes = (prefix: string, name: string, cluster: AgentCluster, s: AgentSettings) => {
        const clusterName = s.clusterName ?? name;
        const { url, registration } = register(prefix, s, clusterName);
        new ObservabilityAgent(`${prefix}/${AGENT}`, {
            cluster,
            chart: agentChart(lab, s),
            url,
            clusterName,
            token: registration.token,
            values: chartValuesWithSecrets(s.values),
            after: [...cluster.ready, registration],
        });
    };

    for (const host of lab.hosts) {
        const s = host.profiles[AGENT] as AgentSettings | undefined;
        if (s) kubernetes(host.name, host.name, targets.hosts[host.name], s);
    }
    for (const d of lab.downstream) {
        const s = d.chartProfiles?.profiles[AGENT] as AgentSettings | undefined;
        if (s) kubernetes(`downstream/${d.name}`, d.name, targets.downstream[d.name], s);
    }
    // On a Harvester, a Harvester add-on: listed (and its values shown) under its Add-ons. Its token
    // is a Secret next to it, out of those values.
    for (const h of lab.harvesters) {
        const s = h.profiles[AGENT] as AgentSettings | undefined;
        if (!s) continue;
        const clusterName = s.clusterName ?? h.name;
        const { url, registration } = register(h.name, s, clusterName, true);
        // Imported into a Rancher of the lab: a Harvester downstream cluster runs on it.
        const imported = lab.downstream.some(d => d.type === "harvester" && d.harvester === h.name);
        const c = agentChart(lab, s);
        const namespace = c.namespace;
        if (!c.repo) throw new Error(`catalog.components.${AGENT} needs a repo: it's a Harvester add-on on ${h.name}`);
        const { provider, ready } = targets.harvesters[h.name];
        const ns = new k8s.core.v1.Namespace(`${h.name}/${AGENT}/namespace`, { metadata: { name: namespace } }, { provider, dependsOn: ready });
        const secret = new k8s.core.v1.Secret(`${h.name}/${AGENT}/token`, {
            metadata: { name: AGENT_SECRET, namespace: ns.metadata.name },
            stringData: { STS_API_KEY: pulumi.secret(registration.token) },
        }, { provider });
        // The lab's values under the engine's; JSON is YAML too.
        const valuesContent = pulumi.output(chartValuesWithSecrets(s.values) ?? {}).apply(own =>
            JSON.stringify(merge(own as Record<string, unknown>, agentValues(url, clusterName, { rancherAgent: imported })), null, 2));
        new HarvesterAddon(`${h.name}/${AGENT}`, {
            harvester: h.name,
            name: AGENT,
            namespace,
            labels: { "addon.harvesterhci.io/experimental": "true" },
            repo: c.repo,
            chart: c.chart,
            version: c.version,
            valuesContent,
            timeoutSeconds: lab.timeouts.harvesterAddon,
        }, { dependsOn: [secret, registration] });
    }
}

/** The agent's chart, in its HelmChart document's namespace; the profile's `version` wins. */
const agentChart = (lab: ResolvedLab, s: AgentSettings) => ({ ...chartInNamespace(AGENT, lab), ...(s.version ? { version: s.version } : {}) });

/** Maps merged key by key, `over` winning. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
    const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isMap(out[k]) && isMap(v) ? merge(out[k] as Record<string, unknown>, v) : v;
    return out;
}
