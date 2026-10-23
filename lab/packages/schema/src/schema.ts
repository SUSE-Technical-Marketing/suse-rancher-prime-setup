import { z } from "zod";
import {
    CIDR, Credentials, dnsLabel, dnsName, FileRef, ImageSource, ipv4, MAC, OS_FAMILIES, osName, quantity,
    SecretRef, secretOrString,
} from "./primitives";
import { Profiles } from "./profiles";

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
    registration: z.strictObject({
        suseconnect: z.strictObject({ regcode: secretOrString }).optional(),
    }).optional(),
    /** Package repositories to add (the format per family is handled by the cloud-init builder). */
    repos: z.array(z.strictObject({
        name: z.string().regex(/^[a-z0-9][-a-z0-9_.]*$/, "must be lowercase letters, digits, '-', '_' and '.'"),
        url: z.url(),
        gpgkey: z.url().optional(),
    })).optional(),
    packages: z.array(z.string()).optional(),
    k8s: z.strictObject({ packages: z.array(z.string()).optional() }).optional(),
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
    clusterNetwork: z.string().default("mgmt"),
    storageClass: z.strictObject({
        name: dnsLabel.default("longhorn-single"),
        replicas: z.int().min(1).max(3).default(1),
    }).default({ name: "longhorn-single", replicas: 1 }),
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
    profiles: Profiles.default({}),
});
export type HostInput = z.infer<typeof HostInput>;

// ---------------------------------------------------------------------------------------------
// Downstream clusters (§5.5)

export const NODE_ROLES = ["etcd", "controlplane", "worker"] as const;
const roles = z.array(z.enum(NODE_ROLES)).min(1);
const labels = z.record(z.string(), z.string()).default({});

const HarvesterPool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    cpu: z.int().min(1),
    memory: quantity,
    disk: quantity,
    os: z.string().min(1),
    network: z.string().optional(),
});

export const DownstreamInput = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("harvester"),
        rancher: z.string(),
        harvester: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        pools: z.array(HarvesterPool).min(1),
    }),
    z.strictObject({
        type: z.literal("custom"),
        rancher: z.string(),
        distro: z.enum(["rke2", "k3s"]).default("rke2"),
        version: z.string().optional(),
        labels,
        nodes: z.array(z.strictObject({ host: z.string(), roles })).min(1),
    }),
]);
export type DownstreamInput = z.infer<typeof DownstreamInput>;

// ---------------------------------------------------------------------------------------------
// The lab file and the personal config

export const LabFile = z.strictObject({
    lab: dnsLabel,
    domain: dnsName,
    tls: z.strictObject({
        acme: z.enum(["letsencrypt", "letsencrypt-staging", "none"]).default("letsencrypt"),
        email: z.email().optional(),
        cloudflare: SecretRef.optional(),
    }).default({ acme: "letsencrypt" }),
    ssh: z.strictObject({
        user: z.string().min(1),
        publicKey: z.union([FileRef, z.string().min(1)]),
        privateKey: SecretRef,
    }).optional(),
    versions: z.record(z.string(), z.string()).default({}),
    harvesters: z.record(dnsLabel, HarvesterInput).default({}),
    hosts: z.record(dnsLabel, HostInput).default({}),
    downstream: z.record(dnsLabel, DownstreamInput).default({}),
    os: z.record(osName, OsProfileInput).default({}),
    images: z.record(osName, ImageSource).default({}),
});
export type LabFile = z.infer<typeof LabFile>;

/** A secret's value in the personal config: a string, or a map of strings (e.g. credentials). */
export const SecretValue = z.union([z.string(), z.record(z.string(), z.string())]);
export type SecretValue = z.infer<typeof SecretValue>;

export const PersonalConfig = z.strictObject({
    secrets: z.record(z.string(), SecretValue).default({}),
    harvesters: z.record(z.string(), PersonalHarvester).default({}),
    images: z.record(osName, ImageSource).default({}),
    os: z.record(osName, OsProfileInput).default({}),
});
export type PersonalConfig = z.infer<typeof PersonalConfig>;
