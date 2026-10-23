import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning } from "@lab/crds";
import { kubeRequest } from "@lab/kube";
import { asRoot, deepMerge, HostAccess, KubeWait, runExisting, sshConnection } from "@lab/kubernetes";
import type { ResolvedDistribution } from "@lab/schema";
import { ClusterKubeconfig } from "./cluster-kubeconfig";
import { RancherAccess } from "./server";

export interface CustomClusterNode {
    host: HostAccess;
    roles: ("etcd" | "controlplane" | "worker")[];
    /** Shell commands run as root before the node registers (the OS's packages for Kubernetes). */
    prepare?: string[];
    /** What has to be done before the node can register (cloud-init on a VM). */
    after?: pulumi.Resource[];
    /** A VM is deleted whole, so it isn't cleaned up first. */
    deletedWith?: pulumi.Resource;
}

export interface CustomClusterArgs {
    rancher: RancherAccess;
    /** Its KubernetesDistribution document: the default CNI and the uninstall scripts. */
    distribution: ResolvedDistribution;
    kubernetesVersion: string;
    labels: Record<string, string>;
    nodes: CustomClusterNode[];
    /** CNI; default the distribution's `cni`. */
    cni?: string;
    /** The lab's own `machineGlobalConfig` and `chartValues`, merged over the engine's. */
    machineGlobalConfig?: Record<string, unknown>;
    chartValues?: Record<string, unknown>;
}

const NS = "fleet-default";
const CLUSTERS = `/apis/provisioning.cattle.io/v1/namespaces/${NS}/clusters`;
const TOKEN_PLACEHOLDER = "{token}";

interface RegistrationInputs {
    rancherKubeconfig: string;
    cluster: string;
    /** Rancher's certificate isn't trusted (Let's Encrypt staging): fetch the installer without checking it. */
    insecure: boolean;
}

/**
 * The command that registers a machine with a custom cluster, read from the cluster's
 * registration token. Newer Rancher keeps the token itself in a Secret next to it.
 */
const registrationProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: RegistrationInputs) {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const rancher = { kubeconfig: inputs.rancherKubeconfig };
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
            const clusterId = (await kubeRequest(rancher, "GET", `${CLUSTERS}/${inputs.cluster}`)).body?.status?.clusterName;
            const crt = clusterId ? (await kubeRequest(rancher, "GET", `/apis/management.cattle.io/v3/namespaces/${clusterId}/clusterregistrationtokens/default-token`)).body : undefined;
            const nodeCommand: string | undefined = inputs.insecure ? crt?.status?.insecureNodeCommand : crt?.status?.nodeCommand;
            if (nodeCommand && !nodeCommand.includes(TOKEN_PLACEHOLDER)) return { id: `${NS}/${inputs.cluster}/registration`, outs: { ...inputs, nodeCommand } };
            const secretName = crt?.status?.tokenSecretName;
            if (nodeCommand && secretName) {
                const encoded = (await kubeRequest(rancher, "GET", `/api/v1/namespaces/${clusterId}/secrets/${secretName}`)).body?.data?.token;
                if (encoded) {
                    const token = Buffer.from(encoded, "base64").toString("utf8").trim();
                    return { id: `${NS}/${inputs.cluster}/registration`, outs: { ...inputs, nodeCommand: nodeCommand.split(TOKEN_PLACEHOLDER).join(token) } };
                }
            }
            await sleep(5000);
        }
        throw new Error(`Rancher made no registration command for cluster ${inputs.cluster} within 5 minutes`);
    },
    async diff(_id: string, olds: RegistrationInputs, news: RegistrationInputs) {
        const replaces = (["cluster", "insecure"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0, replaces };
    },
    async delete() {
        // The token goes with the cluster.
    },
};

class ClusterRegistration extends pulumi.dynamic.Resource {
    declare readonly nodeCommand: pulumi.Output<string>;

    constructor(name: string, args: { rancherKubeconfig: pulumi.Input<string>; cluster: string; insecure: boolean }, opts?: pulumi.CustomResourceOptions) {
        super(registrationProvider, name, { ...args, rancherKubeconfig: pulumi.secret(args.rancherKubeconfig), nodeCommand: undefined },
            { ...opts, additionalSecretOutputs: ["nodeCommand"] }, "lab", "ClusterRegistration");
    }
}


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
export class CustomCluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    /** A provider for the new cluster (through Rancher); resources on it are deleted with the cluster. */
    readonly provider: k8s.Provider;

    constructor(name: string, args: CustomClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:CustomCluster", name, {}, opts);
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
                labels: args.labels,
                // Ready only once nodes have registered, which needs the Cluster first.
                annotations: { "pulumi.com/skipAwait": "true" },
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
            customTimeouts: { delete: "30m" },
        });

        const registration = new ClusterRegistration(`${name}/registration`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            insecure: args.rancher.insecure,
        }, { parent: this, dependsOn: [this.cluster], deletedWith: this.cluster });

        const registered = args.nodes.map((node, i) => {
            const flags = [
                ...(node.roles.includes("etcd") ? ["--etcd"] : []),
                ...(node.roles.includes("controlplane") ? ["--controlplane"] : []),
                ...(node.roles.includes("worker") ? ["--worker"] : []),
                "--node-name", node.host.name,
            ].join(" ");
            const prepare = node.prepare && node.prepare.length > 0 ? `${node.prepare.join(" && ")} && ` : "";
            return new command.remote.Command(`${name}/node/${node.host.name}/register`, {
                connection: sshConnection(node.host),
                create: pulumi.secret(registration.nodeCommand.apply(cmd => asRoot(`${prepare}${cmd} ${flags}`))),
            }, { parent: this, dependsOn: [registration, cleanups[i]], deletedWith: this.cluster });
        });

        const ready = new KubeWait(`${name}/ready`, {
            kubeconfig: args.rancher.cluster.kubeconfig,
            path: `${CLUSTERS}/${clusterName}`,
            condition: "Ready",
            timeoutSeconds: 3600,
        }, { parent: this, dependsOn: registered, deletedWith: this.cluster });

        const kubeconfig = new ClusterKubeconfig(`${name}/kubeconfig`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            rancherUrl: args.rancher.url,
            insecure: args.rancher.insecure,
        }, { parent: this, dependsOn: [ready], deletedWith: this.cluster });
        this.provider = new k8s.Provider(`${name}/provider`, { kubeconfig: kubeconfig.kubeconfig, suppressHelmHookWarnings: true }, { parent: this });

        this.registerOutputs({});
    }
}
