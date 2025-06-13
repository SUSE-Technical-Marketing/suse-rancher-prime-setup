import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export function installSprouter(opts?: pulumi.ComponentResourceOptions): k8s.helm.v3.Release {
    const ns = new k8s.core.v1.Namespace("sprouter", {
        metadata: {
            name: "sprouter",
        },
    }, { ...opts, retainOnDelete: true });

    return new k8s.helm.v3.Release("sprouter", {
        name: "sprouter",
        namespace: ns.metadata.name,
        chart: "oci://ghcr.io/hierynomus/sprouter/charts/sprouter",
    }, { ...opts, parent: ns });
}
