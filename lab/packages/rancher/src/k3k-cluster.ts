import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { k3k, provisioning } from "@lab/crds";
import { KubeWait } from "@lab/kubernetes";
import type { Timeouts } from "@lab/schema";
import { ClusterKubeconfig, managementClusterId } from "./cluster-kubeconfig";
import { ClusterRegistration } from "./registration";
import { RancherAccess } from "./server";

/** The downstream cluster a k3k cluster runs in. */
export interface K3kParent {
    /** Its name in Rancher, as the UI shows it. */
    name: string;
    provider: k8s.Provider;
    /** Its management cluster id (`c-m-...`), which Rancher's UI nests the k3k cluster under. */
    clusterId: pulumi.Input<string>;
    /** Deleting it deletes what's on it: nothing there is deleted one by one when it goes too. */
    cluster: pulumi.Resource;
    /** The k3k operator on it. */
    operator: pulumi.Resource;
}

export interface K3kClusterArgs {
    rancher: RancherAccess;
    parent: K3kParent;
    /** Namespace on the parent the virtual cluster's pods go in. */
    namespace: string;
    mode: "shared" | "virtual" | "hcp";
    servers: number;
    agents: number;
    /** k3s version; default the parent's Kubernetes version. */
    version?: string;
    persistence?: { type: "dynamic" | "ephemeral"; storageClass?: string; size?: string };
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** An image with kubectl and curl, for the import Job on the parent. */
    kubectlImage: string;
    timeouts: Pick<Timeouts, "downstreamReady" | "downstreamDelete" | "clusterRegistration">;
}

const NS = "fleet-default";

/**
 * A k3k virtual cluster in another downstream cluster, imported into Rancher the way its UI does
 * it (pulumi/setups/k3k-cluster-import): the k3k Cluster on the parent; a `provisioning.cattle.io`
 * Cluster without a spec (an imported cluster) whose annotations make the UI show it under its
 * parent; then a Job on the parent that applies Rancher's import manifest with the virtual
 * cluster's kubeconfig, whose server is only reachable from inside the parent.
 *
 * When it goes, the Rancher cluster goes first, then the k3k Cluster and its namespace.
 */
export class K3kCluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    /** A provider for the virtual cluster (through Rancher); resources on it are deleted with the cluster. */
    readonly provider: k8s.Provider;
    readonly clusterId: pulumi.Output<string>;

    constructor(name: string, args: K3kClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:K3kCluster", name, {}, opts);
        const clusterName = name.split("/").pop()!;
        const onParent: pulumi.CustomResourceOptions = { parent: this, provider: args.parent.provider, deletedWith: args.parent.cluster };

        const namespace = new k8s.core.v1.Namespace(`${name}/namespace`, {
            metadata: { name: args.namespace },
        }, { ...onParent, dependsOn: [args.parent.operator] });

        // Named apart from the provisioning Cluster: crd2pulumi aliases the two `Cluster` types.
        const virtual = new k3k.v1beta1.Cluster(`${name}/k3k`, {
            metadata: {
                name: clusterName,
                namespace: namespace.metadata.name,
                annotations: { "pulumi.com/waitFor": "jsonpath={.status.phase}=Ready", "pulumi.com/timeoutSeconds": String(args.timeouts.downstreamReady) },
            },
            spec: {
                mode: args.mode,
                servers: args.servers,
                agents: args.agents,
                ...(args.version ? { version: args.version } : {}),
                ...(args.persistence ? {
                    persistence: {
                        type: args.persistence.type,
                        ...(args.persistence.storageClass ? { storageClassName: args.persistence.storageClass } : {}),
                        ...(args.persistence.size ? { storageRequestSize: args.persistence.size } : {}),
                    },
                } : {}),
            },
        }, { ...onParent, dependsOn: [namespace], customTimeouts: { create: `${args.timeouts.downstreamReady}s` } });

        // An imported cluster; Rancher's UI shows it as k3k under its parent.
        this.cluster = new provisioning.v1.Cluster(`${name}/cluster`, {
            metadata: {
                name: clusterName,
                namespace: NS,
                // Not an empty map: Kubernetes drops it, and every preview would show it again.
                ...(Object.keys(args.labels).length > 0 ? { labels: args.labels } : {}),
                annotations: {
                    ...args.annotations,
                    "rancher.io/imported-cluster-version-management": "false",
                    "ui.rancher/provider": "k3k",
                    "ui.rancher/parent-cluster": args.parent.clusterId,
                    "ui.rancher/parent-cluster-display": args.parent.name,
                    "ui.rancher/k3k-namespace": args.namespace,
                    // Ready only once the import has run, which needs the Cluster first.
                    "pulumi.com/skipAwait": "true",
                },
            },
            spec: {},
        }, {
            parent: this,
            provider: args.rancher.provider,
            dependsOn: [...args.rancher.ready, virtual],
            customTimeouts: { delete: `${args.timeouts.downstreamDelete}s` },
        });

        const registration = new ClusterRegistration(`${name}/registration`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            insecure: args.rancher.insecure,
            timeoutSeconds: args.timeouts.clusterRegistration,
        }, { parent: this, dependsOn: [this.cluster], deletedWith: this.cluster });

        // k3k keeps the virtual cluster's kubeconfig in this Secret; its server is a Service on the parent.
        const script = [
            "set -e",
            "export KUBECONFIG=/kubeconfig/kubeconfig.yaml",
            "until kubectl get --raw /readyz >/dev/null 2>&1; do echo waiting for the k3k API; sleep 5; done",
            `curl -sfL ${args.rancher.insecure ? "--insecure " : ""}"$RANCHER_IMPORT_URL" | kubectl apply -f -`,
        ].join("\n");
        const job = new k8s.batch.v1.Job(`${name}/import`, {
            metadata: { name: `import-${clusterName}`, namespace: namespace.metadata.name },
            spec: {
                backoffLimit: 4,
                template: {
                    spec: {
                        restartPolicy: "Never",
                        containers: [{
                            name: "import",
                            image: args.kubectlImage,
                            command: ["sh", "-c", script],
                            env: [{ name: "RANCHER_IMPORT_URL", value: registration.manifestUrl }],
                            securityContext: { allowPrivilegeEscalation: false },
                            volumeMounts: [{ name: "kubeconfig", mountPath: "/kubeconfig", readOnly: true }],
                        }],
                        volumes: [{ name: "kubeconfig", secret: { secretName: `k3k-${clusterName}-kubeconfig` } }],
                    },
                },
            },
        }, { ...onParent, dependsOn: [virtual, registration], customTimeouts: { create: `${args.timeouts.downstreamReady}s` } });

        // An imported cluster's provisioning Cluster has no Ready condition; its management cluster does.
        const ready = new KubeWait(`${name}/ready`, {
            kubeconfig: args.rancher.cluster.kubeconfig,
            path: pulumi.interpolate`/apis/management.cattle.io/v3/clusters/${registration.clusterId}`,
            condition: "Ready",
            timeoutSeconds: args.timeouts.downstreamReady,
        }, { parent: this, dependsOn: [job], deletedWith: this.cluster });

        const kubeconfig = new ClusterKubeconfig(`${name}/kubeconfig`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            rancherUrl: args.rancher.url,
            insecure: args.rancher.insecure,
        }, { parent: this, dependsOn: [ready], deletedWith: this.cluster });
        this.provider = new k8s.Provider(`${name}/provider`, { kubeconfig: kubeconfig.kubeconfig, suppressHelmHookWarnings: true }, { parent: this });
        this.clusterId = managementClusterId(kubeconfig.kubeconfig);

        this.registerOutputs({});
    }
}
