import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { metallb } from "@lab/crds";
import { KubeAdmitted, onCluster, profileHelmApp } from "@lab/kubernetes";
import { ChartArgs } from "./charts";

export interface MetalLbArgs extends ChartArgs {
    /** Ranges or CIDRs on the host's network it hands out to LoadBalancer services. */
    addresses: string[];
    /** Seconds to wait for its webhook to admit the pool. */
    timeoutSeconds: number;
}

/**
 * MetalLB in L2 mode: one address pool and its L2 advertisement, so LoadBalancer services get an
 * address from the range and the node answers ARP for it. For hosts without a cloud provider
 * (bare metal, or a VM that isn't wired to Harvester's load balancers).
 */
export class MetalLb extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;
    /** Done once the pool can hand out addresses. */
    readonly ready: pulumi.Resource[];

    constructor(name: string, args: MetalLbArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:MetalLb", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const ns = args.chart.namespace;
        this.release = profileHelmApp(`${name}/chart`, args.chart, { lab: args.values }, o);
        const spec = { addresses: args.addresses };
        // The controller's webhook validates the pool; it can be Ready before the API server reaches it.
        const admitted = new KubeAdmitted(`${name}/webhook`, {
            kubeconfig: args.cluster.kubeconfig,
            path: `/apis/metallb.io/v1beta1/namespaces/${ns}/ipaddresspools`,
            object: { apiVersion: "metallb.io/v1beta1", kind: "IPAddressPool", metadata: { name: "lab", namespace: ns }, spec },
            timeoutSeconds: args.timeoutSeconds,
        }, { parent: this, dependsOn: [this.release], deletedWith: args.cluster.deletedWith });
        const pool = new metallb.v1beta1.IPAddressPool(`${name}/pool`, {
            metadata: { name: "lab", namespace: ns },
            spec,
        }, { ...o, dependsOn: [admitted] });
        const l2 = new metallb.v1beta1.L2Advertisement(`${name}/l2`, {
            metadata: { name: "lab", namespace: ns },
            spec: { ipAddressPools: ["lab"] },
        }, { ...o, dependsOn: [pool] });
        this.ready = [pool, l2];
        this.registerOutputs({});
    }
}
