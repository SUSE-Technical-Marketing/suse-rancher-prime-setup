import { z } from "zod";
import { addressFields } from "./addressing";
import { DownstreamInput } from "./clusters";
import { form } from "./form";
import { Inputs, Placement } from "./objects";
import {
    AwsCredentials, awsRegion, awsZone, CIDR, cidr, Credentials, dnsLabel, dnsName, duration, FileRef, ImageSource, ipv4,
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
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24").meta(form({ label: "DHCP CIDR", format: "cidr", placeholder: "10.0.20.0/24" })),
    gateway: ipv4.meta(form({ format: "ip", placeholder: "10.0.20.1" })),
    range: z.tuple([ipv4, ipv4]).meta(form({ label: "DHCP range", widget: "range", hint: "fixed addresses go outside it" })),
    /** Address of the DHCP server itself on this network; default: the second address in `cidr`. */
    server: ipv4.optional().meta(form({ label: "DHCP server", format: "ip", placeholder: "default: the second address" })),
    dns: z.array(ipv4).optional().meta(form({ label: "DNS servers", format: "ip", placeholder: "default: the gateway" })),
});

/**
 * A network without lab DHCP, for VMs with fixed addresses (`ip`): its subnet, gateway and DNS
 * servers, which the VMs get in their network config. A network with lab DHCP has them in `dhcp`.
 */
const Subnet = {
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24").optional()
        .meta(form({ label: "CIDR", format: "cidr", placeholder: "203.0.113.0/24", hint: "for its VMs' fixed addresses" })),
    gateway: ipv4.optional().meta(form({ format: "ip", placeholder: "203.0.113.1" })),
    /** Default: the gateway. */
    dns: z.array(ipv4).optional().meta(form({ label: "DNS servers", format: "ip", placeholder: "default: the gateway" })),
};

/** A Harvester load-balancer IP pool on a network, for LoadBalancer services in guest clusters. */
const LoadBalancerPool = z.strictObject({
    range: z.tuple([ipv4, ipv4]).meta(form({ label: "load-balancer range", widget: "range", hint: "a Harvester LB pool for guest clusters (harvester-cloud-provider)" })),
    /** Default: the network's subnet (its DHCP's `cidr` and `gateway`, or its own). Required on a network with neither. */
    cidr: z.string().regex(CIDR, "must be a CIDR like 10.29.100.0/24").optional()
        .meta(form({ label: "load-balancer CIDR", format: "cidr", placeholder: "default: the network's" })),
    gateway: ipv4.optional().meta(form({ label: "load-balancer gateway", format: "ip", placeholder: "default: the network's" })),
});

export const HarvesterInput = z.strictObject({
    url: z.url().optional().meta(form({ placeholder: "https://harvester.example.com" })),
    credentials: Credentials.optional().meta(form({ widget: "credentials" })),
    /** Skip TLS verification of the Harvester endpoint. Harvester ships a self-signed cert. */
    insecure: z.boolean().optional().meta(form({ hint: "skip TLS verification (Harvester's self-signed certificate)", placeholder: "default: the personal config's, else true" })),
    /** Default: the catalog's Defaults (`mgmt`). */
    clusterNetwork: z.string().min(1).optional().meta(form({ section: "advanced", label: "cluster network", placeholder: "default mgmt" })),
    /** Merged over the catalog's Defaults (`longhorn-single`, 1 replica). */
    storageClass: z.strictObject({
        name: dnsLabel.optional().meta(form({ placeholder: "default longhorn-single" })),
        replicas: z.int().min(1).max(3).optional().meta(form({ placeholder: "default 1" })),
        parameters: z.record(z.string(), z.string()).optional(),
        /** The StorageClass the OS images (and so the VM disks cloned from them) are stored in. Default: `name`. */
        imageClass: z.string().min(1).optional().meta(form({ label: "image storage class", hint: "where OS images and the VM disks cloned from them live", placeholder: "default: the lab's class (name)" })),
    }).optional().meta(form({ section: "advanced", label: "storage class", hint: "merged over the defaults" })),
    /** Profiles on the Harvester itself: those that target Harvesters (the SUSE Observability agent, the DNS controller). */
    profiles: z.record(z.string(), z.record(z.string(), z.unknown()).nullable().transform(v => v ?? {})).default({}).meta(form({ section: "hidden" })),
    networks: z.strictObject({
        default: z.string().optional(),
        untagged: z.strictObject({ dhcp: Dhcp.optional(), loadBalancer: LoadBalancerPool.optional(), ...Subnet }).default({}),
        /** A VLAN with lab DHCP (`dhcp`), or without: then fixed addresses only, on its `cidr`. */
        vlans: z.array(z.strictObject({ id: z.int().min(1).max(4094).meta(form({ label: "VLAN id" })), dhcp: Dhcp.optional(), loadBalancer: LoadBalancerPool.optional(), ...Subnet })).default([]),
    }).default({ untagged: {}, vlans: [] }).meta(form({ section: "hidden" })),
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

/** AWS regions suggested in the lab UI; any region works. */
const AWS_REGIONS = ["eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1", "sa-east-1"];

export const AwsSiteInput = z.strictObject({
    region: awsRegion.optional().meta(form({ suggestions: AWS_REGIONS, placeholder: "{regionPlaceholder}" })),
    credentials: AwsCredentials.optional().meta(form({ widget: "awsCredentials" })),
    /** The lab's VPC; default the catalog's Defaults (`10.100.0.0/16`). A public subnet per zone is cut from it. */
    vpc: z.strictObject({
        cidr: cidr.optional().meta(form({ label: "VPC CIDR", format: "cidr", placeholder: "default {defaults.aws.vpcCidr}", hint: "a /16 to /24; each zone gets a sixteenth" })),
    }).optional().meta(form({ section: "network", inline: true })),
    /** Availability zones, by letter; default the catalog's Defaults (`a`, `b`). */
    zones: z.array(awsZone).min(1).max(6).optional()
        .meta(form({ section: "network", placeholder: "default {defaults.aws.zones}", hint: "by letter; pick others where the account lacks a or b" })),
    /** How long the lab is meant to live: tagged on everything as `lab.geeko.me/expires`. Nothing deletes it by itself. */
    ttl: duration.optional().meta(form({ section: "lifetime", placeholder: "none", hint: "tagged as lab.geeko.me/expires, e.g. 8h; nothing deletes the lab by itself" })),
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
    os: z.string().min(1).meta(form({ label: "OS", options: "osProfiles" })),
    cpu: z.int().min(1).optional().meta(form({ label: "CPUs", placeholder: "default {defaults.vm.cpu}" })),
    memory: quantity.optional().meta(form({ placeholder: "default {defaults.vm.memory}" })),
    disk: quantity.optional().meta(form({ placeholder: "default {defaults.vm.disk}" })),
    /** A network of the Harvester document (`vlan20`), or one already on the Harvester (`default/vlan40`). */
    network: z.string().optional().meta(form({
        suggestionsFrom: "networks", placeholder: "the Harvester's default", hint: "a network of the Harvester document, or one already on the Harvester: namespace/name",
    })),
    ...addressFields,
    /** Its name, when it has one outside the lab (`gitlab.example.com`): instead of `<name>.<domain>`, everywhere. */
    fqdn: dnsName.optional().meta(form({ label: "DNS name", placeholder: "default: <name>.<domain>", hint: "its name outside the lab (its DNS record is yours); used everywhere instead" })),
    address: z.string().optional().meta(form({ hint: "its DNS name or IP" })),
    user: z.string().optional().meta(form({ placeholder: "default: the lab's ssh user" })),
    /** Profile name -> settings; checked against the profile's catalog schema by the resolver. */
    profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}).meta(form({ section: "hidden" })),
    /** Catalog secret and configmap templates to create on the host's cluster (§16.6). */
    secrets: z.array(Placement).optional().meta(form({ section: "advanced", hint: "catalog secrets to create on the host's cluster" })),
    configmaps: z.array(Placement).optional().meta(form({ section: "advanced", hint: "catalog configmaps to create on the host's cluster" })),
    /** Catalog HelmCharts to install on the host's cluster, after its profiles (§17). */
    charts: z.array(ChartPlacement).optional().meta(form({ section: "advanced", hint: "catalog HelmCharts to install after the profiles: [{ name, namespace, values }]" })),
});
export type HostInput = z.infer<typeof HostInput>;

/** A `HarvesterVM` document's spec (DESIGN.md §17): a host the lab creates on one of its Harvesters. */
export const HarvesterVMSpec = z.strictObject({
    /** The `Harvester` document it runs on. */
    harvester: z.string().min(1).meta(form({ label: "Harvester", options: "harvesters" })),
    ...HostInput.omit({ on: true, address: true, user: true }).shape,
});

/** A `Machine` document's spec: an existing machine the lab reaches over SSH. */
export const MachineSpec = z.strictObject({
    address: HostInput.shape.address,
    user: HostInput.shape.user,
    os: HostInput.shape.os.meta(form({ label: "OS", options: "osProfiles", hint: "what the machine runs; its packages and runcmd run over SSH" })),
    ...HostInput.pick({ profiles: true, secrets: true, configmaps: true, charts: true }).shape,
});

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
    domain: dnsName.meta(form({ hint: "hosts are <name>.<domain>" })),
    tls: z.strictObject({
        /** An AcmeServer from the catalog (`letsencrypt`, `letsencrypt-staging`), or `none`. */
        acme: z.string().min(1).default("letsencrypt")
            .meta(form({ label: "ACME server", options: "acme", hint: "staging while iterating: Let's Encrypt allows 5 certificates a week per name" })),
        email: z.email().optional(),
        cloudflare: secretOrString.optional().meta(form({ label: "Cloudflare token", widget: "secret", plain: false, hint: "DNS-01 challenges" })),
    }).default({ acme: "letsencrypt" }).meta(form({ section: "hidden" })),
    ssh: z.strictObject({
        /** Default: the catalog's Defaults (`lab`). */
        user: z.string().min(1).optional().meta(form({ placeholder: "default {defaults.ssh.user}", hint: "the login cloud-init creates on every VM" })),
        publicKey: z.union([FileRef, z.string().min(1)]).meta(form({ label: "public key" })),
        privateKey: secretOrString.meta(form({ label: "private key", widget: "secret", plain: false })),
    }).optional().meta(form({ section: "hidden" })),
    /** Files or directories of more documents (catalog documents; for a lab, its Harvesters, hosts and clusters too). */
    include: Include.meta(form({ section: "advanced", hint: "more files or directories of documents, relative to this file" })),
    /** Values for the inputs of catalog secrets and configmaps (§16.6). */
    inputs: Inputs.default({}).meta(form({ section: "hidden" })),
    /**
     * The lab's own values, any keys at any depth, for templates to refer to: `{{ lab.vars.team }}`
     * in the lab's documents (§5.1), in profiles' chart values and in OS profiles' cloud-init.
     */
    vars: z.record(z.string(), z.unknown()).default({})
        .meta(form({ section: "vars", hint: "e.g. team: tmm, or nested maps and lists; values may use {{ lab.domain }} and secrets" })),
    harvesters: z.record(dnsLabel, HarvesterInput).default({}),
    awsSites: z.record(dnsLabel, AwsSiteInput).default({}),
    hosts: z.record(dnsLabel, HostInput).default({}),
    downstream: z.record(dnsLabel, DownstreamInput).default({}),
    images: z.record(osName, ImageSource).default({}).meta(form({ section: "advanced", hint: "OS image sources by profile name: { url } or { file }" })),
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
