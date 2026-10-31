import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning } from "@lab/crds";
import { kubeRequest } from "@lab/kube";
import { asRoot, deepMerge, helmJobWatch, HostAccess, KubeWait, runExisting, runUploaded, sshConnection, stepScript } from "@lab/kubernetes";
import type { ResolvedDistribution, Timeouts } from "@lab/schema";
import { ClusterKubeconfig, managementClusterId } from "./cluster-kubeconfig";
import { ClusterRegistration } from "./registration";
import { RancherAccess } from "./server";

export interface MetalClusterNode {
    host: HostAccess;
    roles: ("etcd" | "controlplane" | "worker")[];
    /** Shell commands run as root before the node registers (the OS's packages for Kubernetes). */
    prepare?: pulumi.Input<string[]>;
    /** What has to be done before the node can register (cloud-init on a VM). */
    after?: pulumi.Resource[];
    /** A VM is deleted whole, so it isn't cleaned up first. */
    deletedWith?: pulumi.Resource;
}

export interface MetalClusterArgs {
    rancher: RancherAccess;
    /** Its KubernetesDistribution document: the default CNI and the uninstall scripts. */
    distribution: ResolvedDistribution;
    kubernetesVersion: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    nodes: MetalClusterNode[];
    /** CNI; default the distribution's `cni`. */
    cni?: string;
    /** The lab's own `machineGlobalConfig` and `chartValues`, merged over the engine's. */
    machineGlobalConfig?: Record<string, unknown>;
    chartValues?: Record<string, unknown>;
    timeouts: Pick<Timeouts, "clusterRegistration" | "downstreamReady" | "downstreamDelete" | "helmJobWatch">;
}

const NS = "fleet-default";
const CLUSTERS = `/apis/provisioning.cattle.io/v1/namespaces/${NS}/clusters`;
/** Where Rancher's registration command installs its agent's uninstall script. */
const SYSTEM_AGENT_UNINSTALL = "/usr/local/bin/rancher-system-agent-uninstall.sh";

/** What the distribution and then Rancher's agent installed on a node, uninstalled; missing scripts are skipped. */
const nodeCleanup = (d: ResolvedDistribution) => runExisting([...d.uninstall, SYSTEM_AGENT_UNINSTALL]);

/**
 * A cluster Rancher provisions on machines that already exist (DESIGN.md §9.3): the
 * `provisioning.cattle.io` Cluster without machine pools, and on every node Rancher's registration
 * command with the node's roles, run over SSH. Waited on until Ready.
 *
 * On destroy the Cluster is deleted first, while the nodes' agents still run, and then every node
 * that isn't a lab VM is cleaned up with the uninstall scripts: the machine itself stays.
 */
export class MetalCluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    /** A provider for the new cluster (through Rancher); resources on it are deleted with the cluster. */
    readonly provider: k8s.Provider;
    /** Rancher's management cluster id (`c-m-...`). */
    readonly clusterId: pulumi.Output<string>;
    /** Its kubeconfig through Rancher (secret), for checks the provider can't make (a webhook's admission). */
    readonly kubeconfig: pulumi.Output<string>;

    constructor(name: string, args: MetalClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        // Called a custom cluster in Rancher, and here until it was renamed: the alias keeps existing stacks' clusters.
        super("lab:rancher:MetalCluster", name, {}, { ...opts, aliases: [...(opts?.aliases ?? []), { type: "lab:rancher:CustomCluster" }] });
        const clusterName = name.split("/").pop()!;

        // Created before the Cluster so that they're deleted after it.
        const cleanups = args.nodes.map(node => new command.remote.Command(`${name}/node/${node.host.name}/cleanup`, {
            connection: sshConnection(node.host),
            delete: asRoot(nodeCleanup(args.distribution)),
        }, { parent: this, dependsOn: node.after ?? [], ...(node.deletedWith ? { deletedWith: node.deletedWith } : {}) }));

        this.cluster = new provisioning.v1.Cluster(`${name}/cluster`, {
            metadata: {
                name: clusterName,
                namespace: NS,
                // Not an empty map: Kubernetes drops it, and every preview would show it again.
                ...(Object.keys(args.labels).length > 0 ? { labels: args.labels } : {}),
                // Ready only once nodes have registered, which needs the Cluster first.
                annotations: { ...args.annotations, "pulumi.com/skipAwait": "true" },
            },
            spec: {
                kubernetesVersion: args.kubernetesVersion,
                rkeConfig: {
                    machineGlobalConfig: deepMerge(args.machineGlobalConfig ?? {}, { cni: args.cni ?? args.distribution.cni }),
                    chartValues: args.chartValues ?? {},
                },
            },
        }, {
            parent: this,
            provider: args.rancher.provider,
            dependsOn: [...args.rancher.ready, ...cleanups],
            // Rancher removes the nodes from the cluster before the Cluster object goes.
            customTimeouts: { delete: `${args.timeouts.downstreamDelete}s` },
        });

        const registration = new ClusterRegistration(`${name}/registration`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            insecure: args.rancher.insecure,
            timeoutSeconds: args.timeouts.clusterRegistration,
        }, { parent: this, dependsOn: [this.cluster], deletedWith: this.cluster });

        const registered = args.nodes.map((node, i) => {
            const flags = [
                ...(node.roles.includes("etcd") ? ["--etcd"] : []),
                ...(node.roles.includes("controlplane") ? ["--controlplane"] : []),
                ...(node.roles.includes("worker") ? ["--worker"] : []),
                "--node-name", node.host.name,
            ].join(" ");
            // A server node (etcd or control plane) gets the watcher for helm-controller Jobs left suspended.
            const watch = node.roles.some(r => r !== "worker") ? [helmJobWatch(args.distribution, args.timeouts.helmJobWatch)] : [];
            const steps = pulumi.output(node.prepare ?? []).apply(prepare => [...prepare, ...watch]);
            // Uploaded as a script (it holds the registration token: removed once it ran) and run as
            // one; a changed one runs again in place.
            const script = pulumi.secret(pulumi.all([steps, registration.nodeCommand]).apply(([steps, cmd]) => stepScript([...steps, `${cmd} ${flags}`])));
            return new command.remote.Command(`${name}/node/${node.host.name}/register`, {
                connection: sshConnection(node.host),
                create: runUploaded("register"),
                update: runUploaded("register"),
                stdin: script,
            }, { parent: this, dependsOn: [registration, cleanups[i]], deletedWith: this.cluster });
        });

        const ready = new KubeWait(`${name}/ready`, {
            kubeconfig: args.rancher.cluster.kubeconfig,
            path: `${CLUSTERS}/${clusterName}`,
            condition: "Ready",
            timeoutSeconds: args.timeouts.downstreamReady,
        }, { parent: this, dependsOn: registered, deletedWith: this.cluster });

        const kubeconfig = new ClusterKubeconfig(`${name}/kubeconfig`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            rancherUrl: args.rancher.url,
            insecure: args.rancher.insecure,
        }, { parent: this, dependsOn: [ready], deletedWith: this.cluster });
        this.provider = new k8s.Provider(`${name}/provider`, { kubeconfig: kubeconfig.kubeconfig, suppressHelmHookWarnings: true }, { parent: this });
        this.clusterId = managementClusterId(kubeconfig.kubeconfig);
        this.kubeconfig = kubeconfig.kubeconfig;

        this.registerOutputs({});
    }
}
