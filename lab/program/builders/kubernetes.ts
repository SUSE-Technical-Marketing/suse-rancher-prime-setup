import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { clusterFromHost, distroInstall, helmJobWatch, KubeWait } from "@lab/kubernetes";
import type { ResolvedHost } from "@lab/schema";
import { distribution, installCommand, manifest, version } from "../catalog";
import type { CloudInitContext, HostBuilt, ProfileBuilder, ProfileContext, ProfileName } from "../profiles";

// A profile with a `distribution` (k3s, rke2): its KubernetesDistribution installed from the host's
// cloud-init (or over SSH on a machine), then its cluster reached over SSH, with its own ServiceLB,
// Traefik and Gateway API where no other profile replaces them (its fallbacks). `profile` names the
// resources and is the provider in `host.providers`; `dist` is the catalog document.

const kubernetesCloudInit = (profile: string, dist: string, { lab, host }: CloudInitContext, own?: string) => {
    const d = distribution(dist, lab);
    return {
        // What other profiles do instead of the distribution (ingress, load balancing, the cloud provider).
        runcmd: [
            helmJobWatch(d, lab.timeouts.helmJobWatch),
            ...distroInstall(d, installCommand(d, version(dist, lab, own)), host.fqdn, { capabilities: byOthers(host, profile) }).runcmd,
        ],
        uninstall: d.uninstall,
    };
};
/** Capabilities other profiles on the host provide: the distribution turns its own off for those. */
const byOthers = (host: ResolvedHost, profile: string) =>
    Object.entries(host.providers).filter(([, providers]) => !providers.includes(profile)).map(([cap]) => cap);

const kubernetesBuild = (profile: string, dist: string, { lab, host, access, ready, machine }: ProfileContext): HostBuilt => {
    const kubernetes = clusterFromHost(`${host.name}/${profile}`, access, { name: profile, ...distribution(dist, lab) }, lab.timeouts.kubernetesApi, { dependsOn: ready, deletedWith: machine });
    const capabilities: Record<string, pulumi.Resource[]> = {};
    // Its own ServiceLB and Traefik (the profile's fallbacks), when no other profile replaces them.
    // Traefik is there once the distribution has installed its IngressClass.
    if (host.providers["load-balancer"]?.includes(profile)) capabilities["load-balancer"] = [];
    if (host.providers.ingress?.includes(profile)) {
        const ingressClass = String(host.outputs.ingress?.ingressClassName ?? "traefik");
        const ingress = new KubeWait(`${host.name}/${profile}/ingress`, {
            kubeconfig: kubernetes.kubeconfig,
            path: `/apis/networking.k8s.io/v1/ingressclasses/${ingressClass}`,
            timeoutSeconds: lab.timeouts.resourceReady,
        }, { deletedWith: machine });
        capabilities.ingress = [ingress];

        // The Gateway API on that same Traefik (its gateway-api fallback): its Gateway provider turned
        // on through the distribution's own HelmChartConfig, after the CRDs where the distribution
        // doesn't ship them (k3s); its Helm controller upgrades Traefik, which then has a GatewayClass.
        const own = distribution(dist, lab).ingress;
        const gatewayClass = host.outputs["gateway-api"]?.gatewayClassName;
        if (host.providers["gateway-api"]?.includes(profile) && own?.values && gatewayClass) {
            const crds = (own.manifests ?? []).map(m => new k8s.yaml.v2.ConfigFile(`${host.name}/${profile}/${m}`, {
                file: manifest(m, lab).replace(/\{version\}/g, version(m, lab)).replace(/\{channel\}/g, "standard"),
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress] }));
            const config = new k8s.apiextensions.CustomResource(`${host.name}/${profile}/ingress-config`, {
                apiVersion: "helm.cattle.io/v1",
                kind: "HelmChartConfig",
                metadata: { name: own.chart, namespace: "kube-system" },
                // JSON is YAML too.
                spec: { valuesContent: JSON.stringify(own.values) },
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress, ...crds] });
            capabilities["gateway-api"] = [new KubeWait(`${host.name}/${profile}/gateway-class`, {
                kubeconfig: kubernetes.kubeconfig,
                path: `/apis/gateway.networking.k8s.io/v1/gatewayclasses/${String(gatewayClass)}`,
                condition: "Accepted",
                timeoutSeconds: lab.timeouts.resourceReady,
            }, { deletedWith: machine, dependsOn: [config] })];
        }
    }
    return { kubernetes, capabilities };
};

/** The builder of a profile that installs a KubernetesDistribution; its `version` setting, if any, picks another version. */
export const kubernetesBuilder = (profile: string, dist: string): ProfileBuilder<ProfileName> => ({
    cloudInit: (ctx, s) => kubernetesCloudInit(profile, dist, ctx, (s as { version?: string }).version || undefined),
    host: ctx => kubernetesBuild(profile, dist, ctx),
});
