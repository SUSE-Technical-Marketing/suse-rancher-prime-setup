import { z } from "zod";
import { Inputs, Placement } from "./objects";
import {
    CIDR, Credentials, dnsLabel, dnsName, FileRef, ImageSource, ipv4, MAC, OS_FAMILIES, osName, quantity,
    secretOrString,
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
     * The VM's cloud-config (packages, runcmd, bootcmd, write_files, ...). Strings may be Jinja2
     * templates with `secrets` (the personal config's, as everywhere: a registration code) and `lab`
     * (`name`, `domain`). The engine adds the login and the
     * hostname, and appends the host's own commands (k3s / RKE2) to `runcmd`. A variant (one for
     * Kubernetes nodes) is another profile that `extends` this one.
     */
    cloudInit: z.record(z.string(), z.unknown()).optional(),
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
        ...ClusterPassthrough,
        pools: z.array(HarvesterPool).min(1),
    }),
    z.strictObject({
        type: z.literal("custom"),
        rancher: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        annotations,
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
    harvesters: z.record(dnsLabel, HarvesterInput).default({}),
    hosts: z.record(dnsLabel, HostInput).default({}),
    downstream: z.record(dnsLabel, DownstreamInput).default({}),
    images: z.record(osName, ImageSource).default({}),
});
export type LabFile = z.infer<typeof LabFile>;

/**
 * A `Lab` document's spec: the lab-wide settings. Its Harvesters, hosts and downstream clusters are
 * documents of their own (`Harvester`, `HarvesterVM`, `Machine`, `DownstreamCluster`).
 */
export const LabSpec = LabFile.omit({ lab: true, harvesters: true, hosts: true, downstream: true });
export type LabSpec = z.infer<typeof LabSpec>;

/** A secret's value in the personal config: a string, or a map of strings (e.g. credentials). */
export const SecretValue = z.union([z.string(), z.record(z.string(), z.string())]);
export type SecretValue = z.infer<typeof SecretValue>;

export const PersonalConfig = z.strictObject({
    secrets: z.record(z.string(), SecretValue).default({}),
    harvesters: z.record(z.string(), PersonalHarvester).default({}),
    images: z.record(osName, ImageSource).default({}),
    /** Files or directories of more documents (catalog documents; for a lab, its Harvesters, hosts and clusters too). */
    include: Include,
    /** Values for the inputs of catalog secrets and configmaps (§16.6). */
    inputs: Inputs.default({}),
});
export type PersonalConfig = z.infer<typeof PersonalConfig>;
