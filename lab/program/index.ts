import { createHash } from "node:crypto";
import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { AwsNetwork, awsProfile, labTags, Pinned } from "@lab/aws";
import { HarvesterBase, HarvesterVm } from "@lab/harvester";
import { asRoot, ClusterObjects, helmJobWatch, HostAccess, runExisting, runUploaded, sshConnection, stepScript, waitForCloudInit } from "@lab/kubernetes";
import { Amazonec2Credential, HarvesterCredential, HarvesterImport, RancherAccess } from "@lab/rancher";
import { machineSetup, renderCloudConfig, renderNetworkConfig } from "@lab/os";
import { AWS_CREDENTIAL_FIELDS, cloudInitVars, usesSecrets, type CloudInitVars, type ResolvedDownstream, type ResolvedLab, type ResolvedOs } from "@lab/schema";
import {
    buildClusterProfiles, buildHarvesterProfiles, buildHostProfiles, buildLastProfiles, clusterProfiles, hostReady, nodeProfiles, profileBootcmd, profileCloudInit, profileSetup,
    profileUninstall, type LabClusters,
} from "./profiles";
import { objectValue, secretMap, secrets, secretString } from "./secrets";
import { distribution, harvesterChart } from "./catalog";
import { buildCluster, isNested, type BuiltCluster, type ClusterBuildContext } from "./clusters";

// The CLI writes the resolved lab, the secret values and the Harvester versions into stack config
// before every run; this program never reads the lab file itself. Harvester access comes from the
// per-run KUBECONFIG (one context per Harvester), and AWS access from the per-run shared
// credentials file (a profile per site), so neither's credentials are stored in state.
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
        ssh: lab.ssh,
        usedNetworks,
        charts: { dhcpController: harvesterChart("harvester-vm-dhcp-controller", lab, harvesterVersions[h.name]) },
        timeouts: lab.timeouts,
    }, { provider: providers[h.name] });
    // The Harvester's own profiles (the DNS controller): with its base, before its VMs.
    bases[h.name].ready.push(...buildHarvesterProfiles(lab, h, providers[h.name], bases[h.name]));
}

/** Each provisioned cluster's kubeconfig (JSON), by name: host clusters and downstream clusters. */
const clusterKubeconfigs: Record<string, pulumi.Output<string>> = {};

/** Every cluster of the lab, for the profiles' last step (SUSE Observability agents and the clusters they report to). */
const clusters: LabClusters = {
    hosts: {},
    downstream: {},
    fleet: {},
    harvesters: Object.fromEntries(lab.harvesters.map(h => [h.name, { provider: providers[h.name], ready: bases[h.name].ready }])),
};

// --- AWS sites: a VPC per lab -------------------------------------------------------------------------
const awsProviders: Record<string, aws.Provider> = {};
const networks: Record<string, AwsNetwork> = {};
const siteTags: Record<string, Record<string, string>> = {};
for (const s of lab.awsSites) {
    siteTags[s.name] = labTags({ lab: lab.name, site: s, owner: config.get("owner") ?? "unknown", createdAt: config.get("createdAt") });
    awsProviders[s.name] = new aws.Provider(s.name, { region: s.region as aws.Region, profile: awsProfile(s.name), defaultTags: { tags: siteTags[s.name] } });
    networks[s.name] = new AwsNetwork(`aws/${s.name}`, { lab: lab.name, site: s }, { provider: awsProviders[s.name] });
}

/** An OS's AMI in a site's region: the newest matching one when first looked up, kept after that. */
const amis: Record<string, pulumi.Output<string>> = {};
function amiOf(site: string, osName: string): pulumi.Output<string> {
    const key = `${site}/${osName}`;
    if (amis[key]) return amis[key];
    const ami = lab.os[osName].ami!;
    const region = lab.awsSites.find(s => s.name === site)!.region;
    const found = aws.ec2.getAmiOutput({
        owners: [ami.owner],
        mostRecent: true,
        filters: [{ name: "name", values: [ami.name] }, { name: "architecture", values: ["x86_64"] }, { name: "state", values: ["available"] }],
    }, { provider: awsProviders[site] });
    return amis[key] = new Pinned(`aws/${site}/ami/${osName}`, { key: JSON.stringify({ region, ...ami }), value: found.id }).value;
}

// --- Hosts and their profiles --------------------------------------------------------------------
/** What an OS profile's cloud-init templates use: the lab's secrets (kept secret), its name and domain. */
const osVars = (): pulumi.Output<CloudInitVars> => secrets().apply(s => cloudInitVars({ name: lab.name, domain: lab.domain, vars: lab.vars }, s));
/** An existing machine's setup over SSH (its OS profile's Kubernetes part, if it runs Kubernetes); secret when that uses secrets. */
const machineCommands = (os: ResolvedOs, kubernetes: boolean): pulumi.Output<string[]> => {
    const commands = osVars().apply(vars => machineSetup(os, vars, kubernetes));
    return kubernetes && usesSecrets(JSON.stringify(os.kubernetes)) ? pulumi.secret(commands) : commands;
};
const privateKey = lab.ssh ? secretString(lab.ssh.privateKey) : pulumi.output("");
const hostOutputs: Record<string, { fqdn: string; address: pulumi.Output<string> }> = {};
const rancherUrls: Record<string, string> = {};
const rancherAccess: Record<string, RancherAccess> = {};
/** Hosts that are nodes of a metal cluster: Rancher installs Kubernetes on them. */
const metalNodes = new Set(lab.downstream.flatMap(d => d.type === "metal" ? d.nodes.map(n => n.host) : []));
/** How to reach every host that has to be, and when it's ready for that, and the VM if it is one. */
const nodeAccess: Record<string, { access: HostAccess; ready: pulumi.Resource[]; machine?: pulumi.Resource }> = {};

/** A MAC of a VM's own, the same on every run: locally administered, from the lab's and the VM's names. */
function stableMac(labName: string, vm: string): string {
    const h = createHash("sha256").update(`${labName}/${vm}`).digest();
    return ["52", "54", "00", ...[h[0], h[1], h[2]].map(b => b.toString(16).padStart(2, "0"))].join(":");
}

for (const host of lab.hosts) {
    const runcmd = profileCloudInit(lab, host);
    let address: pulumi.Output<string>;
    let ready: pulumi.Resource[] = [];
    let machine: pulumi.Resource | undefined;
    let harvester: { name: string; ready: pulumi.Resource[] } | undefined;

    if (host.kind === "harvester") {
        const base = bases[host.harvester];
        const os = lab.os[host.os];
        const userData = osVars().apply(vars => renderCloudConfig({
            os,
            harvester: true,
            kubernetes: host.kubernetes,
            hostname: host.name,
            fqdn: host.fqdn,
            user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
            vars,
            runcmd,
            bootcmd: profileBootcmd(lab, nodeProfiles(lab, host), os),
        }));
        const vm = new HarvesterVm(host.name, {
            harvester: host.harvester,
            namespace: base.namespace.metadata.name,
            vmName: host.name,
            cpu: host.cpu,
            memory: host.memory,
            disk: host.disk,
            image: base.images[os.image],
            // `namespace/name`: a network already on the Harvester, not the lab's.
            network: host.network.includes("/") ? host.network : base.networks[host.network],
            // A fixed address is set on the interface with this MAC: one of its own, unless the lab gives it one.
            macAddress: host.macAddress ?? (host.ip ? stableMac(lab.name, host.name) : undefined),
            userData: pulumi.secret(userData),
            ...(host.ip ? {
                networkData: renderNetworkConfig({ macAddress: host.macAddress ?? stableMac(lab.name, host.name), ...host.ip, search: [lab.domain] }),
                fixedAddress: host.ip.address,
            } : {}),
            keyPair: pulumi.interpolate`${base.namespace.metadata.name}/${lab.ssh!.user}`,
            timeouts: { start: lab.timeouts.vmStart, address: lab.timeouts.vmAddress },
        }, { provider: providers[host.harvester], dependsOn: base.ready });
        address = vm.ipAddress;
        ready = [vm];
        machine = vm.vm;
        harvester = { name: host.harvester, ready: [base.namespace, ...base.ready] };
    } else {
        address = pulumi.output(host.address);
    }
    hostOutputs[host.name] = { fqdn: host.fqdn, address };

    if (host.profileOrder.length === 0 && !metalNodes.has(host.name)) continue;
    const access: HostAccess = { name: host.name, fqdn: host.fqdn, address, user: host.kind === "ssh" ? host.user : lab.ssh!.user, privateKey };
    let setUp: pulumi.Resource[] = [];
    // Its profiles' setup steps (Landlock): on a VM once cloud-init is done, on an existing machine
    // before its own setup (nothing has run on it yet).
    const os = lab.os[host.os];
    const first = host.kind === "ssh" ? profileSetup(lab, host, { access, os, after: [] }) : [];
    if (host.kind === "harvester") {
        const booted = waitForCloudInit(`${host.name}/cloud-init`, access, lab.timeouts.cloudInit, { dependsOn: ready, deletedWith: machine });
        setUp = profileSetup(lab, host, { access, os, machine, after: [booted] });
    } else if (runcmd.length > 0) {
        // An existing machine gets no user data (it may not even have cloud-init): what a VM's would
        // do (the OS profile's packages and runcmd, the profiles' commands) runs over SSH instead,
        // and when the lab goes the profiles are uninstalled, because the machine stays.
        // Uploaded as a script and run as one, like a VM's runcmd. A changed script runs again in
        // place (update), not as a replacement, which would uninstall the profiles first.
        const script = machineCommands(lab.os[host.os], host.kubernetes).apply(setup => stepScript([...setup, ...runcmd]));
        const setup = new command.remote.Command(`${host.name}/setup`, {
            connection: sshConnection(access),
            create: runUploaded("setup"),
            update: runUploaded("setup"),
            stdin: script,
            delete: asRoot(runExisting(profileUninstall(lab, host))),
        }, { dependsOn: first });
        setUp = [setup];
        // Like a VM: what the profiles create on it goes with the uninstall, not one by one before it.
        machine = setup;
    } else {
        setUp = first;
    }
    nodeAccess[host.name] = { access, ready: setUp, machine };
    if (host.profileOrder.length === 0) continue;
    const outputs = buildHostProfiles(lab, host, access, setUp, machine, harvester);
    if (outputs.fleet) clusters.fleet[host.name] = outputs.fleet;
    if (outputs.kubernetes) clusterKubeconfigs[host.name] = outputs.kubernetes.kubeconfig;
    if (outputs.kubernetes) clusters.hosts[host.name] = { ...outputs.kubernetes, ready: hostReady(outputs) };
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
        timeoutSeconds: lab.timeouts.harvesterImport,
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

// Rancher's credential for an AWS site: its keys, for the node driver (and EKS).
const awsCredentialsFor: Record<string, Amazonec2Credential> = {};
function awsCredential(rancherHost: string, site: string): Amazonec2Credential {
    const key = `${rancherHost}/${site}`;
    if (awsCredentialsFor[key]) return awsCredentialsFor[key];
    const rancher = rancherAccess[rancherHost];
    const s = lab.awsSites.find(x => x.name === site)!;
    const keys = secretMap(s.credentials, AWS_CREDENTIAL_FIELDS);
    return awsCredentialsFor[key] = new Amazonec2Credential(`${rancherHost}/aws-credential/${site}`, {
        url: rancher.url,
        insecure: rancher.insecure,
        username: rancher.username,
        password: rancher.password,
        name: site,
        accessKey: keys.accessKey,
        secretKey: keys.secretKey,
        region: s.region,
    }, { dependsOn: rancher.ready });
}

/**
 * A node's user data on a machine Rancher creates: its OS profile's, Kubernetes part included (and
 * the Harvester part on a Harvester VM), the lab's login, with a server the helm Job watch, and the
 * cluster's profiles' bootcmd (Landlock).
 */
function poolUserData(cluster: ResolvedDownstream, osName: string, roles: string[], harvester: boolean): pulumi.Output<string> {
    const os = lab.os[osName];
    // Only clusters whose machines Rancher creates have pools, and a distribution.
    const distro = "distro" in cluster ? cluster.distro : "rke2";
    return pulumi.secret(osVars().apply(vars => renderCloudConfig({
        os,
        harvester,
        kubernetes: true,
        user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
        defaultUser: true,
        vars,
        runcmd: roles.some(r => r !== "worker") ? [helmJobWatch(distribution(distro, lab), lab.timeouts.helmJobWatch)] : [],
        bootcmd: profileBootcmd(lab, clusterProfiles(cluster), os),
    })));
}

// Each by its type (clusters/); those running inside another (k3k) once the others exist.
const downstreamNames: string[] = [];
const builtClusters: Record<string, BuiltCluster> = {};
const buildContext = (d: ResolvedDownstream): ClusterBuildContext => ({
    lab,
    rancher: rancherAccess[d.rancher],
    harvesterCredential: harvester => harvesterCredential(d.rancher, harvester),
    awsCredential: site => awsCredential(d.rancher, site),
    base: harvester => bases[harvester],
    network: site => networks[site],
    siteTags: site => siteTags[site],
    amiOf,
    poolUserData: (os, roles, harvester) => poolUserData(d, os, roles, harvester),
    node: host => ({ host: lab.hosts.find(h => h.name === host)!, ...nodeAccess[host] }),
    machineCommands,
    built: builtClusters,
});
for (const d of [...lab.downstream.filter(d => !isNested(d)), ...lab.downstream.filter(isNested)]) {
    const cluster = buildCluster(buildContext(d), d);
    placeObjects(d.name, cluster);
    downstreamNames.push(d.name);
    builtClusters[d.name] = cluster;
}

/**
 * What the lab puts on a downstream cluster once it's ready: catalog secrets and configmaps, then
 * its profiles in build order, through Rancher (each after the profiles on it it waits for).
 */
function placeObjects(name: string, cluster: BuiltCluster) {
    const objects = lab.objects.filter(o => "downstream" in o.target && o.target.downstream === name);
    const placed = objects.length > 0 ? new ClusterObjects(`downstream/${name}/objects`, { objects, value: objectValue }, {
        provider: cluster.provider, deletedWith: cluster.cluster, dependsOn: [cluster.cluster],
    }).resources : [];
    clusters.downstream[name] = { provider: cluster.provider, deletedWith: cluster.cluster, ready: [cluster.cluster, ...placed] };
    if (cluster.kubeconfig) clusterKubeconfigs[name] = cluster.kubeconfig;
    // Its profiles in build order, each after the ones it waits for.
    const d = lab.downstream.find(x => x.name === name)!;
    buildClusterProfiles(lab, d, { provider: cluster.provider, deletedWith: cluster.cluster, kubeconfig: cluster.kubeconfig }, [cluster.cluster, ...placed]);
}

// Once every cluster exists: the profiles' last steps (agents reporting to another cluster).
buildLastProfiles(lab, clusters);

export const name = lab.name;
export const harvesters = lab.harvesters.map(h => h.name);
export const awsSites = lab.awsSites.length > 0 ? Object.fromEntries(lab.awsSites.map(s => [s.name, { region: s.region, vpc: networks[s.name].vpc.id }])) : undefined;
export const hosts = hostOutputs;
export const rancher = rancherUrls;
export const downstream = downstreamNames;
/** Each provisioned cluster's kubeconfig, by name: the CLI merges them into one file after `up`. */
export const kubeconfigs = pulumi.secret(pulumi.all(clusterKubeconfigs));
