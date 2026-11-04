import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { AGENT_SECRET, ObservabilityAgent, ObservabilityRegistration } from "@lab/apps";
import { HarvesterAddon } from "@lab/harvester";
import { mergeValues } from "@lab/kubernetes";
import type { RenderedChartEntry, ResolvedLab } from "@lab/schema";
import type { ProfileSettings } from "../generated/profile-settings";
import { chartInNamespace } from "../catalog";
import type { LabClusters, ProfileBuilder, ProfileTarget } from "../profiles";
import { chartValuesWithSecrets, secretString } from "../secrets";

// The suse-observability-agent profile (DESIGN.md §9.6), on lab hosts, downstream clusters and
// Harvesters: built last, once the clusters they report to exist. Each is registered with its
// observer (a downstream cluster whose Fleet profiles run SUSE Observability) through its API, then
// installed with the service token that gives it. Its chart's values are its Profile's, rendered for
// the target by the resolver (overlays included: a Harvester's integrations).

const AGENT = "suse-observability-agent";
type AgentSettings = ProfileSettings["suse-observability-agent"];

export const observabilityAgent: ProfileBuilder<"suse-observability-agent"> = {
    last({ lab, on, clusters }, s) {
        const prefix = on.kind === "cluster" ? `downstream/${on.name}` : on.name;
        const clusterName = s.clusterName ?? on.name;
        if (on.kind === "harvester") {
            harvesterAgent(lab, on.name, clusters, s, clusterName);
            return;
        }
        const cluster = on.kind === "host" ? clusters.hosts[on.name] : clusters.downstream[on.name];
        const { registration } = register(lab, clusters, prefix, s, clusterName);
        const rendered = renderedFor(lab, on);
        new ObservabilityAgent(`${prefix}/${AGENT}`, {
            cluster,
            chart: agentChart(lab, s),
            token: registration.token,
            defaults: rendered.values,
            lockedValues: rendered.lockedValues,
            values: chartValuesWithSecrets(s.values),
            after: [...cluster.ready, registration],
        });
    },
};

/** The agent's subject, role and token on its observer, and its StackPack instance. */
function register(lab: ResolvedLab, clusters: LabClusters, prefix: string, s: AgentSettings, clusterName: string, virtualization = false) {
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
    }, { dependsOn: [...(clusters.downstream[observer.name]?.ready ?? []), ...(clusters.fleet[observer.rancher] ?? [])] });
    return { url, registration };
}

/**
 * On a Harvester, a Harvester add-on: listed (and its values shown) under its Add-ons. Its token is a
 * Secret next to it, out of those values.
 */
function harvesterAgent(lab: ResolvedLab, harvester: string, clusters: LabClusters, s: AgentSettings, clusterName: string) {
    const { registration } = register(lab, clusters, harvester, s, clusterName, true);
    const rendered = renderedFor(lab, { kind: "harvester", name: harvester });
    const c = agentChart(lab, s);
    const namespace = c.namespace;
    if (!c.repo) throw new Error(`catalog.components.${AGENT} needs a repo: it's a Harvester add-on on ${harvester}`);
    const { provider, ready } = clusters.harvesters[harvester];
    const ns = new k8s.core.v1.Namespace(`${harvester}/${AGENT}/namespace`, { metadata: { name: namespace } }, { provider, dependsOn: ready });
    const secret = new k8s.core.v1.Secret(`${harvester}/${AGENT}/token`, {
        metadata: { name: AGENT_SECRET, namespace: ns.metadata.name },
        stringData: { STS_API_KEY: pulumi.secret(registration.token) },
    }, { provider });
    // The lab's values over the profile's defaults, under its locked ones; JSON is YAML too.
    const valuesContent = pulumi.output(chartValuesWithSecrets(s.values) ?? {}).apply(own =>
        JSON.stringify(mergeValues(rendered.values, own as Record<string, unknown>, rendered.lockedValues), null, 2));
    new HarvesterAddon(`${harvester}/${AGENT}`, {
        harvester,
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

/** The agent's chart, in its HelmChart document's namespace; the profile's `version` wins. */
const agentChart = (lab: ResolvedLab, s: AgentSettings) => ({ ...chartInNamespace(AGENT, lab), ...(s.version ? { version: s.version } : {}) });

/** Its chart's values as the resolver rendered them for this host, cluster or Harvester (its Profile's `charts`). */
function renderedFor(lab: ResolvedLab, on: ProfileTarget): RenderedChartEntry {
    const chartValues = on.kind === "host" ? lab.hosts.find(h => h.name === on.name)?.chartValues
        : on.kind === "cluster" ? lab.downstream.find(d => d.name === on.name)?.chartProfiles?.chartValues
        : lab.harvesters.find(h => h.name === on.name)?.chartValues;
    const entry = chartValues?.[AGENT]?.entries[0];
    if (!entry) throw new Error(`${AGENT} on ${on.kind} ${on.name}: no rendered chart values (its observer unresolved?)`);
    return entry;
}
