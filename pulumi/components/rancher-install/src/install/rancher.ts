import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { deepMerge } from "@suse-tmm/utils";

export interface HelmArgs {
    rancherVersion: pulumi.Input<string>; // Optional: specify Rancher version
    values: pulumi.Input<{[key: string]: any}>;
}

const DefaultValues: { [key: string]: any } = {
    agentTLSMode: "system-store",
    global: {
        cattle: {
            psp: {
                enabled: false, // Disable Pod Security Policies
            },
        },
    },
    replicas: 1
};

export function helmInstallRancher(name: string, args: HelmArgs, opts?: pulumi.ComponentResourceOptions): k8s.helm.v3.Release {

    const values = deepMerge(DefaultValues, args.values);

    return new k8s.helm.v3.Release(name, {
        name: "rancher",
        chart: "rancher",
        version: args.rancherVersion,
        namespace: "cattle-system",
        createNamespace: true,
        repositoryOpts: {
            repo: "https://charts.rancher.com/server-charts/prime",
        },
        values: values,
    },opts);
}
