import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { AwsNetwork } from "@lab/aws";
import type { HarvesterBase } from "@lab/harvester";
import type { HostAccess } from "@lab/kubernetes";
import type { Amazonec2Credential, HarvesterCredential, RancherAccess } from "@lab/rancher";
import type { DownstreamType, ResolvedDownstream, ResolvedHost, ResolvedLab, ResolvedOs } from "@lab/schema";

/** A downstream cluster once built: its API, the Rancher cluster object, and its kubeconfig. */
export interface BuiltCluster {
    provider: k8s.Provider;
    /** Deleting it deletes everything on the cluster; it's Ready once this is. */
    cluster: pulumi.Resource;
    /** Rancher's management cluster id (`c-m-…`). */
    clusterId: pulumi.Output<string>;
    kubeconfig?: pulumi.Output<string>;
}

/** A lab host as a metal cluster's node: how to reach it, when it's set up, and what deleting removes it with. */
export interface ClusterNode {
    host: ResolvedHost;
    access: HostAccess;
    ready: pulumi.Resource[];
    machine?: pulumi.Resource;
}

/**
 * What a cluster type's builder gets from the program: the cluster's Rancher, and the lab's shared
 * pieces it builds on (one cloud credential per Rancher and Harvester or site, the site's network),
 * created once, however many clusters use them.
 */
export interface ClusterBuildContext {
    lab: ResolvedLab;
    /** The Rancher that manages the cluster. */
    rancher: RancherAccess;
    /** This Rancher's credential for a Harvester (the Harvester imported into it first). */
    harvesterCredential(harvester: string): HarvesterCredential;
    /** This Rancher's credential for an AWS site. */
    awsCredential(site: string): Amazonec2Credential;
    base(harvester: string): HarvesterBase;
    network(site: string): AwsNetwork;
    siteTags(site: string): Record<string, string>;
    /** An OS's AMI in a site's region. */
    amiOf(site: string, os: string): pulumi.Output<string>;
    /** User data for a machine Rancher creates for this cluster (its OS profile's, the cluster's profiles' bootcmd). */
    poolUserData(os: string, roles: string[], harvester: boolean): pulumi.Output<string>;
    /** A lab host joining as a node. */
    node(host: string): ClusterNode;
    /** An existing machine's setup over SSH for Kubernetes (its OS profile's part). */
    machineCommands(os: ResolvedOs, kubernetes: boolean): pulumi.Output<string[]>;
    /** The clusters built so far, by name: a nested one's parent. */
    built: Record<string, BuiltCluster>;
}

/** How the program builds one downstream cluster type. */
export interface ClusterBuilder<D> {
    /** It runs inside another downstream cluster (k3k): built once the others are. */
    nested?: boolean;
    build(ctx: ClusterBuildContext, d: D): BuiltCluster;
}

/** A resolved downstream cluster of one type. */
export type ClusterOf<T extends DownstreamType> = Extract<ResolvedDownstream, { type: T }>;

/** One builder per cluster type: a type missing here fails to compile. */
export type ClusterBuilders = { [T in DownstreamType]: ClusterBuilder<ClusterOf<T>> };
