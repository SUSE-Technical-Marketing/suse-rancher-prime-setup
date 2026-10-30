import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { AwsNetwork, awsProfile, labTags, Pinned } from "@lab/aws";
import { HarvesterBase, HarvesterCloudConfig, HarvesterVm } from "@lab/harvester";
import { asRoot, ClusterObjects, helmApp, helmJobWatch, HostAccess, runExisting, sshConnection, waitForCloudInit } from "@lab/kubernetes";
import { Amazonec2Credential, Ec2Cluster, EksCluster, HarvesterCluster, HarvesterCredential, HarvesterImport, K3kCluster, MetalCluster, RancherAccess } from "@lab/rancher";
import { machineSetup, renderCloudConfig } from "@lab/os";
import { AWS_CREDENTIAL_FIELDS, cloudInitVars, usesSecrets, type CloudInitVars, type ResolvedLab, type ResolvedOs } from "@lab/schema";
import { buildHostProfiles, profileCloudInit, profileUninstall } from "./profiles";
import { credentials, objectValue, secretMap, secrets, secretString } from "./secrets";
import { chart, chartInNamespace, distribution, harvesterChart, version } from "./catalog";

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
        dnsCredentials: h.dns?.credentials ? credentials(h.dns.credentials) : undefined,
        charts: {
            dhcpController: harvesterChart("harvester-vm-dhcp-controller", lab, harvesterVersions[h.name]),
            dnsController: chart("harvester-dns-controller", lab),
        },
        timeouts: lab.timeouts,
    }, { provider: providers[h.name] });
}

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
        }));
        const vm = new HarvesterVm(host.name, {
            harvester: host.harvester,
            namespace: base.namespace.metadata.name,
            vmName: host.name,
            cpu: host.cpu,
            memory: host.memory,
            disk: host.disk,
            image: base.images[os.image],
            network: base.networks[host.network],
            macAddress: host.macAddress,
            userData: pulumi.secret(userData),
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
    if (host.kind === "harvester") {
        setUp = [waitForCloudInit(`${host.name}/cloud-init`, access, lab.timeouts.cloudInit, { dependsOn: ready, deletedWith: machine })];
    } else if (runcmd.length > 0) {
        // An existing machine gets no user data (it may not even have cloud-init): what a VM's would
        // do (the OS profile's packages and runcmd, the profiles' commands) runs over SSH instead,
        // and when the lab goes the profiles are uninstalled, because the machine stays.
        const setup = new command.remote.Command(`${host.name}/setup`, {
            connection: sshConnection(access),
            create: machineCommands(lab.os[host.os], host.kubernetes).apply(setup => asRoot([...setup, ...runcmd].join(" && "))),
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
 * the Harvester part on a Harvester VM), the lab's login, and with a server the helm Job watch.
 */
function poolUserData(osName: string, distro: "rke2" | "k3s", roles: string[], harvester: boolean): pulumi.Output<string> {
    const os = lab.os[osName];
    return pulumi.secret(osVars().apply(vars => renderCloudConfig({
        os,
        harvester,
        kubernetes: true,
        user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
        defaultUser: true,
        vars,
        runcmd: roles.some(r => r !== "worker") ? [helmJobWatch(distribution(distro, lab), lab.timeouts.helmJobWatch)] : [],
    })));
}

const downstreamNames: string[] = [];
/** The harvester, ec2, eks and metal clusters, by name: k3k clusters run in them. */
const builtClusters: Record<string, MetalCluster | HarvesterCluster | Ec2Cluster | EksCluster> = {};
for (const d of lab.downstream) {
    if (d.type === "k3k") continue;
    if (d.type === "metal") {
        const cluster = new MetalCluster(`downstream/${d.name}`, {
            rancher: rancherAccess[d.rancher],
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            annotations: d.annotations,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            timeouts: lab.timeouts,
            nodes: d.nodes.map(node => {
                const host = lab.hosts.find(h => h.name === node.host)!;
                const { access, ready, machine } = nodeAccess[node.host];
                return {
                    host: access,
                    roles: node.roles,
                    // A lab VM got its OS profile's setup from its user data; a machine gets it now.
                    prepare: host.kind === "ssh" ? machineCommands(lab.os[host.os], true) : [],
                    after: ready,
                    deletedWith: machine,
                };
            }),
        });
        placeObjects(d.name, cluster);
        downstreamNames.push(d.name);
        builtClusters[d.name] = cluster;
        continue;
    }
    if (d.type === "eks") {
        const site = lab.awsSites.find(s => s.name === d.site)!;
        const network = networks[d.site];
        const credential = awsCredential(d.rancher, d.site);
        const cluster = new EksCluster(`downstream/${d.name}`, {
            rancher: rancherAccess[d.rancher],
            region: site.region,
            kubernetesVersion: d.version,
            labels: d.labels,
            annotations: d.annotations,
            cloudCredential: credential.secretName,
            subnetIds: site.zones.map(z => network.subnets[z.letter].id),
            tags: siteTags[d.site],
            publicAccessSources: d.publicAccessSources,
            logging: d.logging,
            nodeGroups: d.nodeGroups.map(g => ({ ...g, subnetIds: g.zones.map(z => network.subnets[z].id) })),
            timeouts: lab.timeouts,
            // The cluster goes before its network does.
            after: [credential, network, ...network.ready],
        });
        placeObjects(d.name, cluster);
        downstreamNames.push(d.name);
        builtClusters[d.name] = cluster;
        continue;
    }
    if (d.type === "ec2") {
        const site = lab.awsSites.find(s => s.name === d.site)!;
        const network = networks[d.site];
        const credential = awsCredential(d.rancher, d.site);
        const cluster = new Ec2Cluster(`downstream/${d.name}`, {
            rancher: rancherAccess[d.rancher],
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            annotations: d.annotations,
            cloudCredential: credential.secretName,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            timeouts: lab.timeouts,
            region: site.region,
            vpcId: network.vpc.id,
            securityGroup: network.securityGroup.name,
            tags: siteTags[d.site],
            pools: d.pools.map(pool => {
                const os = lab.os[pool.os];
                return {
                    ...pool,
                    ami: amiOf(d.site, pool.os),
                    sshUser: os.ami!.user ?? os.defaultUser ?? "ec2-user",
                    subnetId: network.subnets[pool.zone].id,
                    userData: poolUserData(pool.os, d.distro, pool.roles, false),
                };
            }),
            // The machines go before their network does.
            after: [credential, network, ...network.ready],
        });
        placeObjects(d.name, cluster);
        downstreamNames.push(d.name);
        builtClusters[d.name] = cluster;
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
        annotations: d.annotations,
        cloudCredential: credential.secretName,
        vmNamespace: base.namespace.metadata.name,
        sshUser: lab.ssh!.user,
        cloudProviderConfig,
        cni: d.cni,
        machineGlobalConfig: d.machineGlobalConfig,
        chartValues: d.chartValues,
        timeouts: lab.timeouts,
        pools: d.pools.map(pool => ({
            ...pool,
            image: base.images[lab.os[pool.os].image].id,
            network: base.networks[pool.network!],
            userData: poolUserData(pool.os, d.distro, pool.roles, true),
        })),
        after: [credential, base.namespace, ...base.ready],
    });
    placeObjects(d.name, cluster);
    downstreamNames.push(d.name);
    builtClusters[d.name] = cluster;
}

// k3k virtual clusters, once their parents exist. The k3k operator goes on each parent once,
// however many k3k clusters run in it.
const k3kOperators: Record<string, pulumi.Resource> = {};
function k3kOperator(parent: string): pulumi.Resource {
    const cluster = builtClusters[parent];
    return k3kOperators[parent] ??= helmApp(`downstream/${parent}/k3k-operator`, chartInNamespace("k3k", lab), {
        provider: cluster.provider, dependsOn: [cluster.cluster], deletedWith: cluster.cluster,
    });
}
for (const d of lab.downstream) {
    if (d.type !== "k3k") continue;
    const parent = builtClusters[d.parent];
    const cluster = new K3kCluster(`downstream/${d.name}`, {
        rancher: rancherAccess[d.rancher],
        parent: { name: d.parent, provider: parent.provider, clusterId: parent.clusterId, cluster: parent.cluster, operator: k3kOperator(d.parent) },
        namespace: d.namespace!,
        mode: d.mode,
        servers: d.servers,
        agents: d.agents,
        version: d.version,
        persistence: d.persistence,
        labels: d.labels,
        annotations: d.annotations,
        kubectlImage: lab.images.kubectl,
        timeouts: lab.timeouts,
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
export const awsSites = lab.awsSites.length > 0 ? Object.fromEntries(lab.awsSites.map(s => [s.name, { region: s.region, vpc: networks[s.name].vpc.id }])) : undefined;
export const hosts = hostOutputs;
export const rancher = rancherUrls;
export const downstream = downstreamNames;
