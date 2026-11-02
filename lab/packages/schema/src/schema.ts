import { z } from "zod";
import { DownstreamInput } from "./clusters";
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
    /**
     * How the OS turns Landlock on, for hosts and clusters with the `landlock` profile: `enable` is
     * a shell script, run as root, that puts `lsm=$lsm` (the new LSM list, landlock first) on the
     * kernel command line its bootloader uses. The engine runs it only when Landlock isn't active
     * yet, and reboots after it.
     */
    landlock: z.strictObject({ enable: z.string().min(1) }).optional(),
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

/**
 * A network without lab DHCP, for VMs with fixed addresses (`ip`): its subnet, gateway and DNS
 * servers, which the VMs get in their network config. A network with lab DHCP has them in `dhcp`.
 */
const Subnet = {
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24").optional(),
    gateway: ipv4.optional(),
    /** Default: the gateway. */
    dns: z.array(ipv4).optional(),
};

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
    /** Profiles on the Harvester itself: those that target Harvesters (the SUSE Observability agent, the DNS controller). */
    profiles: z.record(z.string(), z.record(z.string(), z.unknown()).nullable().transform(v => v ?? {})).default({}),
    networks: z.strictObject({
        default: z.string().optional(),
        untagged: z.strictObject({ dhcp: Dhcp.optional(), loadBalancer: LoadBalancerPool.optional(), ...Subnet }).default({}),
        /** A VLAN with lab DHCP (`dhcp`), or without: then fixed addresses only, on its `cidr`. */
        vlans: z.array(z.strictObject({ id: z.int().min(1).max(4094), dhcp: Dhcp.optional(), loadBalancer: LoadBalancerPool.optional(), ...Subnet })).default([]),
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
    /** A network of the Harvester document (`vlan20`), or one already on the Harvester (`default/vlan40`). */
    network: z.string().optional(),
    macAddress: z.string().regex(MAC, "must be a MAC address like 52:54:00:aa:bb:01").optional(),
    /**
     * A fixed address, set in the VM itself (cloud-init's network config), no DHCP involved: in the
     * network's subnet, outside its DHCP range. On a network already on the Harvester, with its
     * prefix (`10.29.40.200/24`) and `gateway`, since the lab doesn't know that network.
     */
    ip: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[12][0-9]|3[0-2]))?$/, "must be an IPv4 address, with /prefix on a network the lab doesn't declare").optional(),
    /** For `ip` on a network already on the Harvester: its gateway and (default the gateway) DNS servers. */
    gateway: ipv4.optional(),
    dns: z.array(ipv4).optional(),
    /** Its name, when it has one outside the lab (`gitlab.example.com`): instead of `<name>.<domain>`, everywhere. */
    fqdn: dnsName.optional(),
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
export const MachineSpec = HostInput.omit({ on: true, cpu: true, memory: true, disk: true, network: true, macAddress: true, ip: true, gateway: true, dns: true, fqdn: true });

// ---------------------------------------------------------------------------------------------
// Downstream clusters (§5.5): one module per type, in clusters/.
export { DownstreamInput, NODE_ROLES, type DownstreamType } from "./clusters";

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
