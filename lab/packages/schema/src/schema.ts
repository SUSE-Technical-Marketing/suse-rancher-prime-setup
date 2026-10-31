import { z } from "zod";
import { Inputs, Placement } from "./objects";
import {
    AwsCredentials, awsRegion, awsZone, CIDR, cidr, Credentials, dnsLabel, dnsName, duration, FileRef, ImageSource, ipv4, MAC,
    OS_FAMILIES, osName, quantity, secretOrString,
} from "./primitives";

export * from "./primitives";

// ---------------------------------------------------------------------------------------------
// OS profiles (§6): data, not code. Only `family` maps to code.

/** As written in a YAML file; everything optional so `extends` can fill gaps. */
export const OsProfileInput = z.strictObject({
    name: osName.optional(),
    extends: osName.optional(),
    displayName: z.string().optional(),
    family: z.enum(OS_FAMILIES).optional(),
    image: z.strictObject({ url: z.url().nullable().optional() }).optional(),
    defaultUser: z.string().optional(),
    /**
     * Its image on AWS, for EC2 machines: the newest AMI of `owner` whose name matches `name` (a
     * pattern with `*`), looked up in each site's region. `user` is the AMI's login (Rancher's
     * node driver connects as it); default `defaultUser`.
     */
    ami: z.strictObject({ owner: z.string().min(1), name: z.string().min(1), user: z.string().min(1).optional() }).optional(),
    /**
     * The cloud-config of a host the lab creates (packages, runcmd, bootcmd, write_files, ...).
     * Strings may be Jinja2 templates with `secrets` (the personal config's, as everywhere: a
     * registration code) and `lab` (`name`, `domain`, `vars`). The engine adds the login and the
     * hostname, and appends the host's own commands (k3s / RKE2) to `runcmd`.
     */
    cloudInit: z.record(z.string(), z.unknown()).optional(),
    /** Added on Harvester VMs only (the guest agent): not on EC2 machines or existing ones. */
    harvester: z.strictObject({ cloudInit: z.record(z.string(), z.unknown()).optional() }).optional(),
    /**
     * Added on every host that runs Kubernetes (k3s / RKE2, a cluster's node): what Longhorn needs,
     * no firewalld. The only part an existing machine gets, and only then.
     */
    kubernetes: z.strictObject({ cloudInit: z.record(z.string(), z.unknown()).optional() }).optional(),
});
export type OsProfileInput = z.infer<typeof OsProfileInput>;

// ---------------------------------------------------------------------------------------------
// Harvesters (§5.2)

const Dhcp = z.strictObject({
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24"),
    /** Address of the DHCP server itself on this network; default: the second address in `cidr`. */
    server: ipv4.optional(),
    gateway: ipv4,
    range: z.tuple([ipv4, ipv4]),
    dns: z.array(ipv4).optional(),
});

/** A Harvester load-balancer IP pool on a network, for LoadBalancer services in guest clusters. */
const LoadBalancerPool = z.strictObject({
    range: z.tuple([ipv4, ipv4]),
    /** Default: the network's DHCP `cidr` and `gateway`. Required on networks without lab DHCP. */
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24").optional(),
    gateway: ipv4.optional(),
});

export const HarvesterInput = z.strictObject({
    url: z.url().optional(),
    credentials: Credentials.optional(),
    /** Skip TLS verification of the Harvester endpoint. Harvester ships a self-signed cert. */
    insecure: z.boolean().optional(),
    /** Default: the catalog's Defaults (`mgmt`). */
    clusterNetwork: z.string().min(1).optional(),
    /** Merged over the catalog's Defaults (`longhorn-single`, 1 replica). */
    storageClass: z.strictObject({
        name: dnsLabel.optional(),
        replicas: z.int().min(1).max(3).optional(),
        parameters: z.record(z.string(), z.string()).optional(),
    }).optional(),
    dns: z.strictObject({
        backend: z.literal("routeros"),
        host: ipv4,
        credentials: Credentials.optional(),
    }).optional(),
    networks: z.strictObject({
        default: z.string().optional(),
        untagged: z.strictObject({ dhcp: Dhcp.optional(), loadBalancer: LoadBalancerPool.optional() }).default({}),
        vlans: z.array(z.strictObject({ id: z.int().min(1).max(4094), dhcp: Dhcp, loadBalancer: LoadBalancerPool.optional() })).default([]),
    }).default({ untagged: {}, vlans: [] }),
});
export type HarvesterInput = z.infer<typeof HarvesterInput>;

/** What the personal config may say about a Harvester: where it is and how to log in. */
export const PersonalHarvester = z.strictObject({
    url: z.url().optional(),
    credentials: Credentials.optional(),
    insecure: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// AWS sites (§5.6): an account and region Rancher creates EC2 machines and EKS clusters in. The
// engine makes the lab a VPC there of its own; several labs can share an account.

export const AwsSiteInput = z.strictObject({
    region: awsRegion.optional(),
    credentials: AwsCredentials.optional(),
    /** The lab's VPC; default the catalog's Defaults (`10.100.0.0/16`). A public subnet per zone is cut from it. */
    vpc: z.strictObject({ cidr: cidr.optional() }).optional(),
    /** Availability zones, by letter; default the catalog's Defaults (`a`, `b`). */
    zones: z.array(awsZone).min(1).max(6).optional(),
    /** How long the lab is meant to live: tagged on everything as `lab.geeko.me/expires`. Nothing deletes it by itself. */
    ttl: duration.optional(),
});
export type AwsSiteInput = z.infer<typeof AwsSiteInput>;

/** What the personal config may say about an AWS site: its region and keys. */
export const PersonalAwsSite = z.strictObject({
    region: awsRegion.optional(),
    credentials: AwsCredentials.optional(),
});

// ---------------------------------------------------------------------------------------------
// Hosts (§5.3). One shape for both kinds; the resolver checks which fields apply.

/** A HelmChart from the catalog on a host: its name, optionally another namespace, and values. */
export const ChartPlacement = z.strictObject({
    name: dnsLabel,
    namespace: z.string().min(1).optional(),
    values: z.record(z.string(), z.unknown()).optional(),
});
export type ChartPlacement = z.infer<typeof ChartPlacement>;

export const HostInput = z.strictObject({
    on: z.string().min(1),
    os: z.string().min(1),
    cpu: z.int().min(1).optional(),
    memory: quantity.optional(),
    disk: quantity.optional(),
    network: z.string().optional(),
    macAddress: z.string().regex(MAC, "must be a MAC address like 52:54:00:aa:bb:01").optional(),
    address: z.string().optional(),
    user: z.string().optional(),
    /** Profile name -> settings; checked against the profile's catalog schema by the resolver. */
    profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    /** Catalog secret and configmap templates to create on the host's cluster (§16.6). */
    secrets: z.array(Placement).optional(),
    configmaps: z.array(Placement).optional(),
    /** Catalog HelmCharts to install on the host's cluster, after its profiles (§17). */
    charts: z.array(ChartPlacement).optional(),
});
export type HostInput = z.infer<typeof HostInput>;

/** A `HarvesterVM` document's spec (DESIGN.md §17): a host the lab creates on one of its Harvesters. */
export const HarvesterVMSpec = HostInput.omit({ on: true, address: true, user: true }).extend({
    /** The `Harvester` document it runs on. */
    harvester: z.string().min(1),
});

/** A `Machine` document's spec: an existing machine the lab reaches over SSH. */
export const MachineSpec = HostInput.omit({ on: true, cpu: true, memory: true, disk: true, network: true, macAddress: true });

// ---------------------------------------------------------------------------------------------
// Downstream clusters (§5.5)

export const NODE_ROLES = ["etcd", "controlplane", "worker"] as const;
const roles = z.array(z.enum(NODE_ROLES)).min(1);
const labels = z.record(z.string(), z.string()).default({});
/** On the provisioning Cluster; Rancher copies them to the Fleet cluster (`.ClusterAnnotations` in fleet.yaml). */
const annotations = z.record(z.string(), z.string()).default({});
/** Fleet profiles (§16.3) by name: their labels and annotations go on the cluster, and Fleet installs what they select. */
const fleetProfiles = z.record(z.string().min(1), z.strictObject({})).default({});

const HarvesterPool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    /** Default: the catalog's Defaults (`vm`). */
    cpu: z.int().min(1).optional(),
    memory: quantity.optional(),
    disk: quantity.optional(),
    os: z.string().min(1),
    network: z.string().optional(),
});

const Ec2Pool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    /** Default: the catalog's Defaults (`aws.instanceType`). */
    instanceType: z.string().min(1).optional(),
    /** Root volume; default the catalog's Defaults (`vm.disk`). */
    disk: quantity.optional(),
    os: z.string().min(1),
    /** Its availability zone, by letter; default the site's first. */
    zone: awsZone.optional(),
});

const EksNodeGroup = z.strictObject({
    name: dnsLabel,
    /** Nodes it starts with; it scales between min and max (default both this). */
    quantity: z.int().min(1),
    min: z.int().min(0).optional(),
    max: z.int().min(1).optional(),
    /** Default: the catalog's Defaults (`aws.instanceType`). */
    instanceType: z.string().min(1).optional(),
    /** Each node's volume; default the catalog's Defaults (`vm.disk`). */
    disk: quantity.optional(),
    /** Its availability zones, by letter; default all of the site's. */
    zones: z.array(awsZone).min(1).optional(),
    /** Kubernetes labels on its nodes. */
    labels: z.record(z.string(), z.string()).optional(),
});

/** Rancher cluster settings beyond the engine's (§16.5): passed through, merged over the engine's. */
const ClusterPassthrough = {
    /** CNI; default calico for RKE2, flannel for k3s. */
    cni: z.string().min(1).optional(),
    /** Merged into `rkeConfig.machineGlobalConfig` (the distro's config.yaml on every node). */
    machineGlobalConfig: z.record(z.string(), z.unknown()).optional(),
    /** Merged into `rkeConfig.chartValues` (values for the distro's bundled charts). */
    chartValues: z.record(z.string(), z.unknown()).optional(),
    /** Catalog secrets and configmaps to create on the cluster once it is Ready (§16.6). */
    secrets: z.array(Placement).optional(),
    configmaps: z.array(Placement).optional(),
};

export const DownstreamInput = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("harvester"),
        rancher: z.string(),
        harvester: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        annotations,
        fleetProfiles,
        /** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
        profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        ...ClusterPassthrough,
        pools: z.array(HarvesterPool).min(1),
    }),
    z.strictObject({
        /** Machines Rancher creates on EC2 with its node driver, in the site's VPC (§5.5). */
        type: z.literal("ec2"),
        rancher: z.string(),
        /** The AwsSite its machines go in. */
        site: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        annotations,
        fleetProfiles,
        /** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
        profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        ...ClusterPassthrough,
        pools: z.array(Ec2Pool).min(1),
    }),
    z.strictObject({
        /** An EKS cluster Rancher creates and manages (hosted), in the site's VPC (§5.5). */
        type: z.literal("eks"),
        rancher: z.string(),
        /** The AwsSite whose VPC it runs in; it needs two zones at least. */
        site: z.string(),
        /** EKS Kubernetes minor (1.34); default the catalog's Defaults (`aws.eksVersion`). */
        version: z.string().regex(/^1\.\d+$/, "an EKS minor such as 1.34").optional(),
        labels,
        annotations,
        fleetProfiles,
        /** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
        profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        /** Who may reach its API endpoint besides Rancher's proxy; default anyone. */
        publicAccessSources: z.array(cidr).optional(),
        /** Control plane logs sent to CloudWatch: api, audit, authenticator, controllerManager, scheduler. */
        logging: z.array(z.enum(["api", "audit", "authenticator", "controllerManager", "scheduler"])).optional(),
        secrets: z.array(Placement).optional(),
        configmaps: z.array(Placement).optional(),
        nodeGroups: z.array(EksNodeGroup).min(1),
    }),
    z.strictObject({
        /** Rancher installs Kubernetes on the lab's own hosts (Machines, bare VMs): Rancher's "custom" cluster. */
        type: z.literal("metal"),
        rancher: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        annotations,
        fleetProfiles,
        /** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
        profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        ...ClusterPassthrough,
        nodes: z.array(z.strictObject({ host: z.string(), roles })).min(1),
    }),
    z.strictObject({
        /** A k3k virtual cluster inside another downstream cluster, imported into Rancher (§5.5). */
        type: z.literal("k3k"),
        rancher: z.string(),
        /** The DownstreamCluster it runs in; the engine installs the k3k operator there. */
        parent: z.string(),
        /** shared: its workloads are pods of the parent; virtual: it has its own nodes, as pods; hcp: hosted control plane. */
        mode: z.enum(["shared", "virtual", "hcp"]).default("shared"),
        servers: z.int().min(1).default(1),
        agents: z.int().min(0).default(0),
        /** Its k3s version (v1.33.1-k3s1); default the parent's Kubernetes version. */
        version: z.string().optional(),
        /** Namespace on the parent; default `k3k-<name>`. */
        namespace: dnsLabel.optional(),
        /** etcd data: on a PVC (`dynamic`, the parent's default StorageClass unless `storageClass`) or `ephemeral`. */
        persistence: z.strictObject({
            type: z.enum(["dynamic", "ephemeral"]).default("dynamic"),
            storageClass: z.string().min(1).optional(),
            size: quantity.optional(),
        }).optional(),
        labels,
        annotations,
        fleetProfiles,
        /** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
        profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        secrets: z.array(Placement).optional(),
        configmaps: z.array(Placement).optional(),
    }),
]);
export type DownstreamInput = z.infer<typeof DownstreamInput>;

// ---------------------------------------------------------------------------------------------
// The catalog (DESIGN.md §16): defaults as data, layered built-in -> personal config -> lab file

/** YAML reads `41` or `1.10` as numbers; versions are always strings. */
const versionString = z.union([z.string().min(1), z.number()]).transform(String);

/** A version, or Harvester minor (`"1.9"`) -> version for components that follow the Harvester. */
export const VersionValue = z.union([versionString, z.record(z.string().regex(/^\d+\.\d+$/, "must be a Harvester minor like 1.9"), versionString)]);
export type VersionValue = z.infer<typeof VersionValue>;

/** More documents, from files or directories, relative to the file that names them. */
export const Include = z.array(z.string().min(1)).default([]);

// ---------------------------------------------------------------------------------------------
// The lab file and the personal config

export const LabFile = z.strictObject({
    lab: dnsLabel,
    domain: dnsName,
    tls: z.strictObject({
        /** An AcmeServer from the catalog (`letsencrypt`, `letsencrypt-staging`), or `none`. */
        acme: z.string().min(1).default("letsencrypt"),
        email: z.email().optional(),
        cloudflare: secretOrString.optional(),
    }).default({ acme: "letsencrypt" }),
    ssh: z.strictObject({
        /** Default: the catalog's Defaults (`lab`). */
        user: z.string().min(1).optional(),
        publicKey: z.union([FileRef, z.string().min(1)]),
        privateKey: secretOrString,
    }).optional(),
    /** Files or directories of more documents (catalog documents; for a lab, its Harvesters, hosts and clusters too). */
    include: Include,
    /** Values for the inputs of catalog secrets and configmaps (§16.6). */
    inputs: Inputs.default({}),
    /**
     * The lab's own values, any keys at any depth, for templates to refer to: `{{ lab.vars.team }}`
     * in the lab's documents (§5.1), in profiles' chart values and in OS profiles' cloud-init.
     */
    vars: z.record(z.string(), z.unknown()).default({}),
    harvesters: z.record(dnsLabel, HarvesterInput).default({}),
    awsSites: z.record(dnsLabel, AwsSiteInput).default({}),
    hosts: z.record(dnsLabel, HostInput).default({}),
    downstream: z.record(dnsLabel, DownstreamInput).default({}),
    images: z.record(osName, ImageSource).default({}),
});
export type LabFile = z.infer<typeof LabFile>;

/**
 * A `Lab` document's spec: the lab-wide settings. Its Harvesters, hosts and downstream clusters are
 * documents of their own (`Harvester`, `HarvesterVM`, `Machine`, `DownstreamCluster`).
 */
export const LabSpec = LabFile.omit({ lab: true, harvesters: true, awsSites: true, hosts: true, downstream: true });
export type LabSpec = z.infer<typeof LabSpec>;

/**
 * A secret's value in the personal config: a string, or a map of strings (e.g. credentials). Any
 * other YAML is let through here, so a value for something else (a nested map another tool reads)
 * doesn't break the file: a lab that uses it gets told its shape is wrong (cli/src/secrets.ts).
 */
export const SecretValue = z.unknown();
export type SecretValue = z.infer<typeof SecretValue>;

export const PersonalConfig = z.strictObject({
    secrets: z.record(z.string(), SecretValue).default({}),
    harvesters: z.record(z.string(), PersonalHarvester).default({}),
    awsSites: z.record(z.string(), PersonalAwsSite).default({}),
    images: z.record(osName, ImageSource).default({}),
    /** Files or directories of more documents (catalog documents; for a lab, its Harvesters, hosts and clusters too). */
    include: Include,
    /** Values for the inputs of catalog secrets and configmaps (§16.6). */
    inputs: Inputs.default({}),
    /** Defaults for every lab's `vars` (`{{ lab.vars.team }}`): a lab's own win, key by key (§5.1). */
    vars: z.record(z.string(), z.unknown()).default({}),
});
export type PersonalConfig = z.infer<typeof PersonalConfig>;
