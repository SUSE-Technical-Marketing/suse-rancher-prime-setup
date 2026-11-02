import type { ResolvedOs } from "../os";
import type { ResolvedAwsSite, ResolvedHarvester, ResolvedHost } from "../resolve";
import type { DownstreamInput } from "./index";

/**
 * What a cluster type's resolve step gets from the resolver: the lab around it (hosts, Harvesters,
 * AWS sites, already resolved), the catalog's defaults, and the resolver's checks for what it uses.
 */
export interface ClusterContext {
    error(path: string, message: string): void;
    /** The lab file's downstream clusters, as written (a k3k cluster's parent). */
    inputs: Record<string, DownstreamInput>;
    hosts: Map<string, ResolvedHost>;
    harvesters: Map<string, ResolvedHarvester>;
    awsSites: Map<string, ResolvedAwsSite>;
    defaults: { vm: { cpu: number; memory: string; disk: string }; aws: { instanceType: string; eksVersion: string } };
    /** An OS profile the cluster's machines use (reported when unknown; counted as used). */
    useOs(name: string, at: string): ResolvedOs | undefined;
    /** An OS image the cluster's VMs need on a Harvester. */
    needImage(harvester: string, os: string): void;
    /** A network of a Harvester, checked: its `namespace/name` or lab network name. */
    checkNetwork(harvester: ResolvedHarvester, network: string | undefined, at: string): string;
    /** A metal cluster's nodes, by host -> the cluster: a host joins one at most. */
    metalNodeOwner: Map<string, string>;
    /** The profiles on a host that keep it from being a metal cluster's node (they bring Kubernetes). */
    blocksMetalNode(host: ResolvedHost): string[];
}

/** What a cluster has on AWS: where, what's billed, and what to look for when checking for leftovers. */
export interface AwsFootprint {
    /** The AwsSite it runs in. */
    site: string;
    /** Machines billed while the lab runs, by instance type. */
    machines: { instanceType: string; quantity: number }[];
    /** EKS control planes, billed per hour. */
    controlPlanes: number;
    /** Its machines' key pairs start with these (the node driver names them `<cluster>-<pool>-<id>`). */
    keyPairPrefixes: string[];
    /** The EKS clusters it creates, by name (with their CloudFormation stacks). */
    eksClusters: string[];
}

/**
 * One downstream cluster type (DESIGN.md §5.5): its schema is a member of `DownstreamInput`; the
 * resolver checks what all clusters share (their Rancher) and leaves the rest to `resolve`.
 */
export interface ClusterType<Input, Resolved> {
    /** Its machines reach Rancher over the internet, so its Rancher must be public: what reaches it, for the error. */
    reachesRancherOverInternet?: string;
    /** The cluster as the program builds it: defaults filled in, checked against the rest of the lab. */
    resolve(ctx: ClusterContext, name: string, input: Input, at: string): Resolved;
    /** On AWS: its site, what's billed and what it leaves behind if a delete fails. */
    aws?(d: Resolved & { name: string }): AwsFootprint;
    /** Its lines in `lab plan`, after the cluster's name; `meta` is its labels and annotations. */
    plan(d: Resolved & { name: string }, meta: string): string[];
}
