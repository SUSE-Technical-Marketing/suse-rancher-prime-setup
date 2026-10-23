import * as pulumi from "@pulumi/pulumi";
import { CertManager, HARVESTER_POOL_ANNOTATIONS, HarvesterCloudProvider, LETSENCRYPT_STAGING_ROOTS, Outrider, Sprouter, Traefik } from "@lab/apps";
import { HarvesterCloudConfig } from "@lab/harvester";
import { ClusterAccess, clusterFromHost, Distro, distroInstall, HostAccess } from "@lab/kubernetes";
import { DEFAULT_REPOS, Fleet, liz, RancherAccess, RancherServer, UiPlugins } from "@lab/rancher";
import { hostCapabilities } from "@lab/schema";
import type { ProfileName, ProfileSettings, ResolvedHost, ResolvedLab } from "@lab/schema";
import { credentials, secretString } from "./secrets";
import { DEFAULT_PLUGINS, version } from "./versions";

/**
 * What a host offers to the profiles built after it, keyed by capability (DESIGN.md §7.6).
 * `ready` lists what a consumer has to wait for.
 */
export interface HostOutputs {
    kubernetes?: ClusterAccess;
    "load-balancer"?: { serviceAnnotations: Record<string, string>; ready: pulumi.Resource[] };
    tls?: { secretName: string; ready: pulumi.Resource[] };
    ingress?: { ingressClassName: string; ready: pulumi.Resource[] };
    "secret-propagation"?: { ready: pulumi.Resource[] };
    "downstream-secrets"?: { ready: pulumi.Resource[] };
    rancher?: RancherAccess;
}

export interface CloudInitContext {
    lab: ResolvedLab;
    host: ResolvedHost;
}

export interface ProfileContext extends CloudInitContext {
    access: HostAccess;
    /** The VM, for a Harvester host: deleting it deletes everything on it. */
    machine?: pulumi.Resource;
    /** The Harvester a VM runs on, and what has to exist there first (namespace, networks, pools). */
    harvester?: { name: string; ready: pulumi.Resource[] };
    /** The host is up and cloud-init has finished. */
    ready: pulumi.Resource[];
    /** Outputs of the profiles already built on this host, in `profileOrder`. */
    outputs: HostOutputs;
}

/** One profile's build steps. `cloudInit` runs before the VM exists, `build` after it is up. */
export interface ProfileBuilder<N extends ProfileName> {
    cloudInit?(ctx: CloudInitContext, settings: ProfileSettings<N>): { runcmd: string[] };
    build(ctx: ProfileContext, settings: ProfileSettings<N>): HostOutputs | void;
}

/** The resolver guarantees required capabilities exist; this only narrows the type. */
function need<K extends keyof HostOutputs>(ctx: ProfileContext, capability: K): NonNullable<HostOutputs[K]> {
    const value = ctx.outputs[capability];
    if (!value) throw new Error(`host ${ctx.host.name}: ${capability} isn't available (profile order bug)`);
    return value as NonNullable<HostOutputs[K]>;
}

const notBuiltYet = (profile: ProfileName, milestone: string) => ({
    build(ctx: ProfileContext): void {
        pulumi.log.warn(`host ${ctx.host.name}: the ${profile} profile isn't built yet (${milestone}); nothing is created for it`);
    },
});

const kubernetesCloudInit = (distro: Distro, { lab, host }: CloudInitContext, own?: string) => ({
    runcmd: distroInstall(distro, version(distro, lab.versions, own), host.fqdn, {
        // Another profile (harvester-cloud-provider) does load balancing: no ServiceLB, external CCM.
        externalCloudProvider: hostCapabilities(host.profiles).has("load-balancer"),
    }).runcmd,
});
const kubernetesBuild = (distro: Distro, { host, access, ready, machine }: ProfileContext): HostOutputs =>
    ({ kubernetes: clusterFromHost(`${host.name}/${distro}`, access, distro, { dependsOn: ready, deletedWith: machine }) });

/**
 * One builder per profile defined in `@lab/schema` (`PROFILES`). The mapped type makes a
 * missing builder a compile error, so a profile can't be declared without being buildable.
 */
export const BUILDERS: { [N in ProfileName]: ProfileBuilder<N> } = {
    k3s: { cloudInit: (ctx, s) => kubernetesCloudInit("k3s", ctx, s.version), build: ctx => kubernetesBuild("k3s", ctx) },
    rke2: { cloudInit: (ctx, s) => kubernetesCloudInit("rke2", ctx, s.version), build: ctx => kubernetesBuild("rke2", ctx) },

    "harvester-cloud-provider": {
        build(ctx, settings) {
            const { lab, host } = ctx;
            if (!ctx.harvester) throw new Error(`host ${host.name}: harvester-cloud-provider only runs on Harvester VMs`);
            const name = `${host.name}/harvester-cloud-provider`;
            const cloudConfig = new HarvesterCloudConfig(`${name}/cloud-config`, {
                harvester: ctx.harvester.name,
                namespace: lab.name,
                serviceAccountName: `${host.name}-cloud-provider`,
            }, { dependsOn: ctx.harvester.ready });
            const ccm = new HarvesterCloudProvider(name, {
                cluster: need(ctx, "kubernetes"),
                version: version("harvester-cloud-provider", lab.versions, settings.version),
                cloudConfig: cloudConfig.kubeconfig,
                clusterName: host.name,
            });
            return { "load-balancer": { serviceAnnotations: HARVESTER_POOL_ANNOTATIONS, ready: [ccm.release] } };
        },
    },

    "cert-manager": {
        build(ctx, settings) {
            const { lab, host } = ctx;
            if (lab.tls.acme === "none" || !lab.tls.email || !lab.tls.cloudflare) {
                throw new Error(`host ${host.name}: cert-manager needs tls.acme, tls.email and tls.cloudflare in the lab file`);
            }
            const cm = new CertManager(`${host.name}/cert-manager`, {
                cluster: need(ctx, "kubernetes"),
                version: version("cert-manager", lab.versions, settings.version),
                email: lab.tls.email,
                cloudflareToken: secretString(lab.tls.cloudflare),
                issuer: lab.tls.acme === "letsencrypt-staging" ? "letsencrypt-staging" : "letsencrypt-prod",
                wildcardDomain: host.fqdn,
            });
            return { tls: { secretName: cm.secretName, ready: [cm.certificate] } };
        },
    },

    sprouter: {
        build(ctx, settings) {
            const s = new Sprouter(`${ctx.host.name}/sprouter`, { cluster: need(ctx, "kubernetes"), version: version("sprouter", ctx.lab.versions, settings.version) });
            return { "secret-propagation": { ready: [s.release] } };
        },
    },

    traefik: {
        build(ctx, settings) {
            const t = new Traefik(`${ctx.host.name}/traefik`, {
                cluster: need(ctx, "kubernetes"),
                version: version("traefik", ctx.lab.versions, settings.version),
                gatewayApi: {
                    version: version("gateway-api", ctx.lab.versions, settings.gatewayApi?.version),
                    channel: settings.gatewayApi?.channel ?? "standard",
                },
                // With a load-balancer profile on the host, its Service takes an address from it.
                serviceAnnotations: ctx.outputs["load-balancer"]?.serviceAnnotations,
                after: ctx.outputs["load-balancer"]?.ready,
            });
            return { ingress: { ingressClassName: t.ingressClassName, ready: [t.release] } };
        },
    },

    outrider: {
        build(ctx, settings) {
            const o = new Outrider(`${ctx.host.name}/outrider`, { cluster: need(ctx, "kubernetes"), version: version("outrider", ctx.lab.versions, settings.version) });
            return { "downstream-secrets": { ready: [o.release] } };
        },
    },

    rancher: {
        build(ctx, settings) {
            const { lab, host } = ctx;
            const tls = need(ctx, "tls");
            const ingress = need(ctx, "ingress");
            const name = `${host.name}/rancher`;
            const server = new RancherServer(name, {
                cluster: need(ctx, "kubernetes"),
                version: version("rancher", lab.versions, settings.version),
                hostname: `${settings.hostname}.${host.fqdn}`,
                ingressClassName: ingress.ingressClassName,
                tlsSecretName: tls.secretName,
                adminPassword: secretString(settings.adminPassword),
                insecure: lab.tls.acme === "letsencrypt-staging",
                // Agents (imported Harvesters, downstream nodes) have to trust the staging certificate.
                privateCa: lab.tls.acme === "letsencrypt-staging" ? LETSENCRYPT_STAGING_ROOTS : undefined,
            }, { dependsOn: [...tls.ready, ...ingress.ready, ...need(ctx, "secret-propagation").ready] });
            const rancher = server.access;

            const plugins = settings.plugins ?? DEFAULT_PLUGINS;
            new UiPlugins(`${name}/plugins`, {
                rancher,
                plugins: Object.fromEntries(plugins.map(p => [p, version(`plugin/${p}`, lab.versions)])),
            });
            if (settings.liz) liz(`${name}/liz`, rancher, version("rancher-ai-agent", lab.versions), server);

            const fleet = settings.fleet ?? { groups: {}, repos: "default" as const };
            const s = fleet.secrets;
            new Fleet(`${name}/fleet`, {
                rancher,
                secrets: s ? {
                    appco: s.appco ? credentials(s.appco) : undefined,
                    scc: s.scc ? credentials(s.scc) : undefined,
                    suseObservabilityLicense: s["suse-observability-license"] ? secretString(s["suse-observability-license"]) : undefined,
                    certManager: lab.tls.email && lab.tls.cloudflare ? { email: lab.tls.email, cloudflareToken: secretString(lab.tls.cloudflare) } : undefined,
                } : undefined,
                groups: fleet.groups,
                repos: fleet.repos === "default" ? DEFAULT_REPOS : fleet.repos === "none" ? [] : fleet.repos,
            }, { dependsOn: ctx.outputs["downstream-secrets"]?.ready ?? [] });
            return { rancher };
        },
    },

    hauler: notBuiltYet("hauler", "M5"),
    "mlm-server": notBuiltYet("mlm-server", "M6"),
    "mlm-client": notBuiltYet("mlm-client", "M6"),
};

type AnyBuilder = ProfileBuilder<ProfileName>;
const builderOf = (name: ProfileName) => BUILDERS[name] as unknown as AnyBuilder;
const settingsOf = (host: ResolvedHost, name: ProfileName) => host.profiles[name] as ProfileSettings<ProfileName>;

/** cloud-init `runcmd` lines the host's profiles contribute, in build order. */
export function profileCloudInit(lab: ResolvedLab, host: ResolvedHost): string[] {
    return host.profileOrder.flatMap(name => builderOf(name).cloudInit?.({ lab, host }, settingsOf(host, name)).runcmd ?? []);
}

/** Build a host's profiles in the order the resolver worked out from their rules. */
export function buildHostProfiles(
    lab: ResolvedLab,
    host: ResolvedHost,
    access: HostAccess,
    ready: pulumi.Resource[],
    machine?: pulumi.Resource,
    harvester?: ProfileContext["harvester"],
): HostOutputs {
    const outputs: HostOutputs = {};
    for (const name of host.profileOrder) {
        Object.assign(outputs, builderOf(name).build({ lab, host, access, ready, machine, harvester, outputs }, settingsOf(host, name)) ?? {});
    }
    return outputs;
}
