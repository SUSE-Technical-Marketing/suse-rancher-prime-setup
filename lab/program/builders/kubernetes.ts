import * as k8s from "@pulumi/kubernetes";
import { clusterFromHost, distroInstall, helmJobWatch, KubeWait, type Distro } from "@lab/kubernetes";
import type { ResolvedHost } from "@lab/schema";
import { distribution, installCommand, manifest, version } from "../catalog";
import type { CloudInitContext, HostOutputs, ProfileBuilder, ProfileContext } from "../profiles";

// The k3s and rke2 profiles: the distribution installed from the host's cloud-init (or over SSH on a
// machine), then its cluster reached over SSH, with its own ServiceLB, Traefik and Gateway API where
// no other profile replaces them (their fallbacks).

const kubernetesCloudInit = (distro: Distro, { lab, host }: CloudInitContext, own?: string) => {
    const d = distribution(distro, lab);
    return {
        // What other profiles do instead of the distribution (ingress, load balancing, the cloud provider).
        runcmd: [
            helmJobWatch(d, lab.timeouts.helmJobWatch),
            ...distroInstall(d, installCommand(d, version(distro, lab, own)), host.fqdn, { capabilities: byOthers(host, distro) }).runcmd,
        ],
        uninstall: d.uninstall,
    };
};
/** Capabilities other profiles on the host provide: the distribution turns its own off for those. */
const byOthers = (host: ResolvedHost, profile: string) =>
    Object.entries(host.providers).filter(([, providers]) => !providers.includes(profile)).map(([cap]) => cap);

const kubernetesBuild = (distro: Distro, { lab, host, access, ready, machine }: ProfileContext): HostOutputs => {
    const kubernetes = clusterFromHost(`${host.name}/${distro}`, access, { name: distro, ...distribution(distro, lab) }, lab.timeouts.kubernetesApi, { dependsOn: ready, deletedWith: machine });
    const outputs: HostOutputs = { kubernetes };
    // Its own ServiceLB and Traefik (the profile's fallbacks), when no other profile replaces them.
    // Traefik is there once the distribution has installed its IngressClass.
    if (host.providers["load-balancer"]?.includes(distro)) outputs["load-balancer"] = { ready: [] };
    if (host.providers.ingress?.includes(distro)) {
        const ingressClass = String(host.outputs.ingress?.ingressClassName ?? "traefik");
        const ingress = new KubeWait(`${host.name}/${distro}/ingress`, {
            kubeconfig: kubernetes.kubeconfig,
            path: `/apis/networking.k8s.io/v1/ingressclasses/${ingressClass}`,
            timeoutSeconds: lab.timeouts.resourceReady,
        }, { deletedWith: machine });
        outputs.ingress = { ready: [ingress] };

        // The Gateway API on that same Traefik (its gateway-api fallback): its Gateway provider turned
        // on through the distribution's own HelmChartConfig, after the CRDs where the distribution
        // doesn't ship them (k3s); its Helm controller upgrades Traefik, which then has a GatewayClass.
        const own = distribution(distro, lab).ingress;
        const gatewayClass = host.outputs["gateway-api"]?.gatewayClassName;
        if (host.providers["gateway-api"]?.includes(distro) && own?.values && gatewayClass) {
            const crds = (own.manifests ?? []).map(m => new k8s.yaml.v2.ConfigFile(`${host.name}/${distro}/${m}`, {
                file: manifest(m, lab).replace(/\{version\}/g, version(m, lab)).replace(/\{channel\}/g, "standard"),
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress] }));
            const config = new k8s.apiextensions.CustomResource(`${host.name}/${distro}/ingress-config`, {
                apiVersion: "helm.cattle.io/v1",
                kind: "HelmChartConfig",
                metadata: { name: own.chart, namespace: "kube-system" },
                // JSON is YAML too.
                spec: { valuesContent: JSON.stringify(own.values) },
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress, ...crds] });
            outputs["gateway-api"] = {
                ready: [new KubeWait(`${host.name}/${distro}/gateway-class`, {
                    kubeconfig: kubernetes.kubeconfig,
                    path: `/apis/gateway.networking.k8s.io/v1/gatewayclasses/${String(gatewayClass)}`,
                    condition: "Accepted",
                    timeoutSeconds: lab.timeouts.resourceReady,
                }, { deletedWith: machine, dependsOn: [config] })],
            };
        }
    }
    return outputs;
};

export const k3s: ProfileBuilder<"k3s"> = { cloudInit: (ctx, s) => kubernetesCloudInit("k3s", ctx, s.version), host: ctx => kubernetesBuild("k3s", ctx) };
export const rke2: ProfileBuilder<"rke2"> = { cloudInit: (ctx, s) => kubernetesCloudInit("rke2", ctx, s.version), host: ctx => kubernetesBuild("rke2", ctx) };
