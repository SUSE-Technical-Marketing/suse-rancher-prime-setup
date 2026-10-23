import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { parse } from "yaml";
import type { ResolvedDistribution } from "@lab/schema";
import { readyCheck } from "./distro";
import { HostAccess, sshConnection } from "./host";

/** A lab Kubernetes cluster: its kubeconfig (JSON, secret) and a provider for it. */
export interface ClusterAccess {
    name: string;
    kubeconfig: pulumi.Output<string>;
    provider: k8s.Provider;
    /**
     * The machine the cluster lives on, when deleting it deletes the cluster (a lab VM). Everything
     * on the cluster is `deletedWith` it: tearing down Rancher & co. one by one is slow and fragile
     * (Rancher's post-delete job) when the VM goes anyway. Unset for existing (ssh) machines.
     */
    deletedWith?: pulumi.Resource;
}

/** Options for a resource on a lab cluster. */
export function onCluster(cluster: ClusterAccess, parent: pulumi.Resource, extra: pulumi.CustomResourceOptions = {}): pulumi.CustomResourceOptions {
    return { parent, provider: cluster.provider, deletedWith: cluster.deletedWith, ...extra };
}

/** Options for a dynamic resource talking to a lab cluster (no Kubernetes provider). */
export function withCluster(cluster: ClusterAccess, parent: pulumi.Resource, extra: pulumi.CustomResourceOptions = {}): pulumi.CustomResourceOptions {
    return { parent, deletedWith: cluster.deletedWith, ...extra };
}

/**
 * Turn the distribution's kubeconfig into one that works from the CLI's machine: server at the
 * host's address instead of 127.0.0.1, context named after the host, JSON so dynamic providers
 * can read it without a YAML parser.
 */
export function rewriteKubeconfig(yamlText: string, name: string, address: string): string {
    const kc = parse(yamlText);
    const cluster = kc.clusters[0].cluster;
    cluster.server = cluster.server.replace(/\/\/[^:/]+/, `//${address}`);
    return JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name, cluster }],
        users: [{ name, user: kc.users[0].user }],
        contexts: [{ name, context: { cluster: name, user: name } }],
        "current-context": name,
    });
}

/**
 * Read a host's kubeconfig over SSH once its API server is ready. The admin kubeconfig is the one
 * credential the lab keeps in state: encrypted, and gone with the lab.
 */
export function clusterFromHost(name: string, host: HostAccess, distro: { name: string } & Pick<ResolvedDistribution, "kubeconfig" | "kubectl">, opts: pulumi.ComponentResourceOptions & { deletedWith?: pulumi.Resource }): ClusterAccess {
    const check = readyCheck(distro);
    const read = new command.remote.Command(`${name}/kubeconfig`, {
        connection: sshConnection(host),
        create: [
            `for i in $(seq 1 120); do ${check} >/dev/null 2>&1 && ready=1 && break; sleep 5; done;`,
            `[ -n "$ready" ] || { echo "${distro.name} API server not ready after 10 minutes; last check:" >&2; ${check} >&2; exit 1; };`,
            `sudo cat ${distro.kubeconfig}`,
        ].join(" "),
        logging: "stderr",
    }, {
        ...opts,
        additionalSecretOutputs: ["stdout"],
        // Read once per VM. Changing this script must not re-read the kubeconfig: during preview the
        // output would be unknown, which makes Pulumi replace the cluster's provider and with it
        // everything on the cluster. A new VM still re-reads it, through its new address.
        ignoreChanges: ["create"],
    });

    const kubeconfig = pulumi.secret(pulumi.all([read.stdout, host.address]).apply(([text, address]) => rewriteKubeconfig(text, host.name, address)));
    const provider = new k8s.Provider(`${name}/provider`, { kubeconfig, suppressHelmHookWarnings: true }, { parent: opts.parent });
    return { name: host.name, kubeconfig, provider, deletedWith: opts.deletedWith };
}
