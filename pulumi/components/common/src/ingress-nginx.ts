import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export function installIngressNginx(version: pulumi.Input<string>, opts?: pulumi.ComponentResourceOptions): k8s.helm.v3.Release {
    const ns = new k8s.core.v1.Namespace("ingress-nginx", {
        metadata: {
            name: "ingress-nginx",
        },
    }, { ...opts, retainOnDelete: true });

    return new k8s.helm.v3.Release("ingress-nginx", {
        name: "ingress-nginx",
        chart: "ingress-nginx",
        version: version,
        namespace: ns.metadata.name,
        repositoryOpts: {
            repo: "https://kubernetes.github.io/ingress-nginx",
        },
    }, { ...opts, parent: ns });
}
