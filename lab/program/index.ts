import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { HarvesterBase, HarvesterCloudConfig, HarvesterVm } from "@lab/harvester";
import { HostAccess, waitForCloudInit } from "@lab/kubernetes";
import { HarvesterCluster, HarvesterCredential, HarvesterImport, RancherAccess } from "@lab/rancher";
import { renderCloudConfig } from "@lab/os";
import { hostCapabilities } from "@lab/schema";
import type { ResolvedLab } from "@lab/schema";
import { buildHostProfiles, profileCloudInit } from "./profiles";
import { credentials, secretString } from "./secrets";
import { dhcpControllerVersion, version } from "./versions";

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
        versions: {
            dhcpController: dhcpControllerVersion(harvesterVersions[h.name], lab.versions),
            dnsController: version("harvester-dns-controller", lab.versions),
        },
    }, { provider: providers[h.name] });
}

// --- Hosts and their profiles --------------------------------------------------------------------
const privateKey = lab.ssh ? secretString(lab.ssh.privateKey) : pulumi.output("");
const hostOutputs: Record<string, { fqdn: string; address: pulumi.Output<string> }> = {};
const rancherUrls: Record<string, string> = {};
const rancherAccess: Record<string, RancherAccess> = {};

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
            kubernetes: hostCapabilities(host.profiles).has("kubernetes"),
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
        if (runcmd.length > 0) {
            throw new Error(`host ${host.name}: installing ${host.profileOrder.join(", ")} on an existing (ssh) machine isn't supported yet (M4)`);
        }
        address = pulumi.output(host.address);
    }
    hostOutputs[host.name] = { fqdn: host.fqdn, address };

    if (host.profileOrder.length === 0) continue;
    const access: HostAccess = { name: host.name, fqdn: host.fqdn, address, user: host.kind === "ssh" ? host.user : lab.ssh!.user, privateKey };
    const cloudInitDone = waitForCloudInit(`${host.name}/cloud-init`, access, { dependsOn: ready, deletedWith: machine });
    const outputs = buildHostProfiles(lab, host, access, [cloudInitDone], machine, harvester);
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
    if (d.type !== "harvester") {
        pulumi.log.warn(`downstream cluster ${d.name}: custom clusters aren't built yet (M4); nothing is created for it`);
        continue;
    }
    const base = bases[d.harvester];
    const credential = harvesterCredential(d.rancher, d.harvester);
    const cloudProviderConfig = d.distro === "rke2" ? new HarvesterCloudConfig(`downstream/${d.name}/cloud-provider-config`, {
        harvester: d.harvester,
        namespace: base.namespace.metadata.name,
        serviceAccountName: d.name,
    }, { dependsOn: [base.namespace] }).kubeconfig : undefined;
    new HarvesterCluster(`downstream/${d.name}`, {
        rancher: rancherAccess[d.rancher],
        distro: d.distro,
        kubernetesVersion: d.version ?? version(d.distro, lab.versions),
        labels: d.labels,
        cloudCredential: credential.secretName,
        vmNamespace: base.namespace.metadata.name,
        sshUser: lab.ssh!.user,
        cloudProviderConfig,
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
    downstreamNames.push(d.name);
}

export const name = lab.name;
export const harvesters = lab.harvesters.map(h => h.name);
export const hosts = hostOutputs;
export const rancher = rancherUrls;
export const downstream = downstreamNames;
