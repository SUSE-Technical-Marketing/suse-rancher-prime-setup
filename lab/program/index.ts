import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { HarvesterBase, HarvesterCloudConfig, HarvesterVm } from "@lab/harvester";
import { asRoot, ClusterObjects, HostAccess, runExisting, sshConnection, waitForCloudInit } from "@lab/kubernetes";
import { CustomCluster, HarvesterCluster, HarvesterCredential, HarvesterImport, RancherAccess } from "@lab/rancher";
import { installCommands, renderCloudConfig } from "@lab/os";
import type { ResolvedLab } from "@lab/schema";
import { buildHostProfiles, profileCloudInit, profileUninstall } from "./profiles";
import { credentials, objectValue, secretString } from "./secrets";
import { chart, distribution, harvesterChart, version } from "./catalog";

// The CLI writes the resolved lab, the secret values and the Harvester versions into stack config
// before every run; this program never reads the lab file itself. Harvester access comes from the
// per-run KUBECONFIG (one context per Harvester), so no Harvester credentials are stored in state.
const config = new pulumi.Config("lab");
const lab = config.requireObject<ResolvedLab>("resolved");
const harvesterVersions = config.getObject<Record<string, string | undefined>>("harvesterVersions") ?? {};

// --- Harvester bases ---------------------------------------------------------------------------
const providers: Record<string, k8s.Provider> = {};
const bases: Record<string, HarvesterBase> = {};
for (const h of lab.harvesters) {
    providers[h.name] = new k8s.Provider(h.name, { context: h.name, suppressHelmHookWarnings: true });
    const usedNetworks = [
        ...lab.hosts.flatMap(host => host.kind === "harvester" && host.harvester === h.name ? [host.network] : []),
        ...lab.downstream.flatMap(d => d.type === "harvester" && d.harvester === h.name ? d.pools.map(p => p.network!) : []),
    ];
    bases[h.name] = new HarvesterBase(h.name, {
        harvester: h,
        namespace: lab.name,
        domain: lab.domain,
        ssh: { user: lab.ssh?.user ?? "lab", publicKey: lab.ssh?.publicKey ?? "" },
        usedNetworks,
        dnsCredentials: h.dns?.credentials ? credentials(h.dns.credentials) : undefined,
        charts: {
            dhcpController: harvesterChart("harvester-vm-dhcp-controller", lab, harvesterVersions[h.name]),
            dnsController: chart("harvester-dns-controller", lab),
        },
    }, { provider: providers[h.name] });
}

// --- Hosts and their profiles --------------------------------------------------------------------
const privateKey = lab.ssh ? secretString(lab.ssh.privateKey) : pulumi.output("");
const hostOutputs: Record<string, { fqdn: string; address: pulumi.Output<string> }> = {};
const rancherUrls: Record<string, string> = {};
const rancherAccess: Record<string, RancherAccess> = {};
/** Hosts that are nodes of a custom cluster: Rancher installs Kubernetes on them. */
const customNodes = new Set(lab.downstream.flatMap(d => d.type === "custom" ? d.nodes.map(n => n.host) : []));
/** How to reach every host that has to be, and when it's ready for that, and the VM if it is one. */
const nodeAccess: Record<string, { access: HostAccess; ready: pulumi.Resource[]; machine?: pulumi.Resource }> = {};

for (const host of lab.hosts) {
    const runcmd = profileCloudInit(lab, host);
    let address: pulumi.Output<string>;
    let ready: pulumi.Resource[] = [];
    let machine: pulumi.Resource | undefined;
    let harvester: { name: string; ready: pulumi.Resource[] } | undefined;

    if (host.kind === "harvester") {
        const base = bases[host.harvester];
        const os = lab.os[host.os];
        const regcode = os.registration?.suseconnect?.regcode;
        const regcodeValue: pulumi.Output<string | undefined> = regcode ? secretString(regcode) : pulumi.output(undefined);
        const userData = regcodeValue.apply(code => renderCloudConfig({
            os,
            hostname: host.name,
            fqdn: host.fqdn,
            user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
            regcode: code,
            kubernetes: host.capabilities.includes("kubernetes") || customNodes.has(host.name),
            runcmd,
        }));
        const vm = new HarvesterVm(host.name, {
            harvester: host.harvester,
            namespace: base.namespace.metadata.name,
            vmName: host.name,
            cpu: host.cpu,
            memory: host.memory,
            disk: host.disk,
            image: base.images[host.os],
            network: base.networks[host.network],
            macAddress: host.macAddress,
            userData: pulumi.secret(userData),
            keyPair: pulumi.interpolate`${base.namespace.metadata.name}/${lab.ssh!.user}`,
        }, { provider: providers[host.harvester], dependsOn: base.ready });
        address = vm.ipAddress;
        ready = [vm];
        machine = vm.vm;
        harvester = { name: host.harvester, ready: [base.namespace, ...base.ready] };
    } else {
        address = pulumi.output(host.address);
    }
    hostOutputs[host.name] = { fqdn: host.fqdn, address };

    if (host.profileOrder.length === 0 && !customNodes.has(host.name)) continue;
    const access: HostAccess = { name: host.name, fqdn: host.fqdn, address, user: host.kind === "ssh" ? host.user : lab.ssh!.user, privateKey };
    let setUp: pulumi.Resource[] = [];
    if (host.kind === "harvester") {
        setUp = [waitForCloudInit(`${host.name}/cloud-init`, access, { dependsOn: ready, deletedWith: machine })];
    } else if (runcmd.length > 0) {
        // An existing machine gets no user data (it may not even have cloud-init): what a VM's would
        // do (the OS's Kubernetes packages, the profiles' commands) runs over SSH instead, and when
        // the lab goes the profiles are uninstalled, because the machine stays.
        const os = lab.os[host.os];
        const packages = host.capabilities.includes("kubernetes") ? installCommands(os, os.k8s.packages) : [];
        const setup = new command.remote.Command(`${host.name}/setup`, {
            connection: sshConnection(access),
            create: asRoot([...packages, ...runcmd].join(" && ")),
            delete: asRoot(runExisting(profileUninstall(lab, host))),
        });
        setUp = [setup];
        // Like a VM: what the profiles create on it goes with the uninstall, not one by one before it.
        machine = setup;
    }
    nodeAccess[host.name] = { access, ready: setUp, machine };
    if (host.profileOrder.length === 0) continue;
    const outputs = buildHostProfiles(lab, host, access, setUp, machine, harvester);
    if (outputs.rancher) {
        rancherUrls[host.name] = outputs.rancher.url;
        rancherAccess[host.name] = outputs.rancher;
    }
}

// --- Downstream clusters ------------------------------------------------------------------------
// Each Harvester a Rancher provisions on is imported into it once, with one cloud credential.
const credentialsFor: Record<string, HarvesterCredential> = {};
function harvesterCredential(rancherHost: string, harvester: string): HarvesterCredential {
    const key = `${rancherHost}/${harvester}`;
    if (credentialsFor[key]) return credentialsFor[key];
    const rancher = rancherAccess[rancherHost];
    const imported = new HarvesterImport(`${rancherHost}/import/${harvester}`, {
        rancherKubeconfig: rancher.cluster.kubeconfig,
        harvester,
        name: harvester,
        insecure: rancher.insecure,
    }, { dependsOn: [...rancher.ready, bases[harvester].namespace] });
    return credentialsFor[key] = new HarvesterCredential(`${rancherHost}/credential/${harvester}`, {
        url: rancher.url,
        insecure: rancher.insecure,
        username: rancher.username,
        password: rancher.password,
        name: harvester,
        clusterId: imported.clusterId,
    }, { dependsOn: [imported] });
}

const downstreamNames: string[] = [];
for (const d of lab.downstream) {
    if (d.type === "custom") {
        const cluster = new CustomCluster(`downstream/${d.name}`, {
            rancher: rancherAccess[d.rancher],
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            nodes: d.nodes.map(node => {
                const host = lab.hosts.find(h => h.name === node.host)!;
                const { access, ready, machine } = nodeAccess[node.host];
                return {
                    host: access,
                    roles: node.roles,
                    // A lab VM got the OS's Kubernetes packages from its user data; a machine gets them now.
                    prepare: host.kind === "ssh" ? installCommands(lab.os[host.os], lab.os[host.os].k8s.packages) : [],
                    after: ready,
                    deletedWith: machine,
                };
            }),
        });
        placeObjects(d.name, cluster);
        downstreamNames.push(d.name);
        continue;
    }
    const base = bases[d.harvester];
    const credential = harvesterCredential(d.rancher, d.harvester);
    const cloudProviderConfig = d.distro === "rke2" ? new HarvesterCloudConfig(`downstream/${d.name}/cloud-provider-config`, {
        harvester: d.harvester,
        namespace: base.namespace.metadata.name,
        serviceAccountName: d.name,
    }, { dependsOn: [base.namespace] }).kubeconfig : undefined;
    const cluster = new HarvesterCluster(`downstream/${d.name}`, {
        rancher: rancherAccess[d.rancher],
        distro: d.distro,
        distribution: distribution(d.distro, lab),
        kubernetesVersion: d.version ?? version(d.distro, lab),
        labels: d.labels,
        cloudCredential: credential.secretName,
        vmNamespace: base.namespace.metadata.name,
        sshUser: lab.ssh!.user,
        cloudProviderConfig,
        cni: d.cni,
        machineGlobalConfig: d.machineGlobalConfig,
        chartValues: d.chartValues,
        pools: d.pools.map(pool => {
            const os = lab.os[pool.os];
            const regcode = os.registration?.suseconnect?.regcode;
            const regcodeValue: pulumi.Output<string | undefined> = regcode ? secretString(regcode) : pulumi.output(undefined);
            return {
                ...pool,
                image: base.images[pool.os].id,
                network: base.networks[pool.network!],
                userData: pulumi.secret(regcodeValue.apply(code => renderCloudConfig({
                    os,
                    user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
                    defaultUser: true,
                    regcode: code,
                    kubernetes: true,
                }))),
            };
        }),
        after: [credential, base.namespace, ...base.ready],
    });
    placeObjects(d.name, cluster);
    downstreamNames.push(d.name);
}

/** The catalog secrets and configmaps placed on a downstream cluster, once it is Ready. */
function placeObjects(name: string, cluster: { provider: k8s.Provider; cluster: pulumi.Resource }) {
    const objects = lab.objects.filter(o => "downstream" in o.target && o.target.downstream === name);
    if (objects.length === 0) return;
    new ClusterObjects(`downstream/${name}/objects`, { objects, value: objectValue }, {
        provider: cluster.provider, deletedWith: cluster.cluster, dependsOn: [cluster.cluster],
    });
}

export const name = lab.name;
export const harvesters = lab.harvesters.map(h => h.name);
export const hosts = hostOutputs;
export const rancher = rancherUrls;
export const downstream = downstreamNames;
