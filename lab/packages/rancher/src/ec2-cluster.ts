import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning, rke_machine_config } from "@lab/crds";
import { NodeDriverClusterArgs, nodeDriverCluster, NodePool, NS, toGiB } from "./node-driver-cluster";

export interface Ec2MachinePool extends NodePool {
    instanceType: string;
    /** Root volume. */
    disk: string;
    ami: pulumi.Input<string>;
    /** The AMI's login: the node driver connects as it, with a key pair it makes per machine. */
    sshUser: string;
    /** Availability zone by letter, and the subnet the machines go in there. */
    zone: string;
    subnetId: pulumi.Input<string>;
    userData: pulumi.Input<string>;
}

export interface Ec2ClusterArgs extends NodeDriverClusterArgs {
    region: string;
    vpcId: pulumi.Input<string>;
    /** The security group the machines run in, by name; the node driver leaves its rules alone. */
    securityGroup: pulumi.Input<string>;
    /** On every machine, so leftovers can be found by them. */
    tags: Record<string, string>;
    pools: Ec2MachinePool[];
}

/**
 * A cluster Rancher provisions on EC2 with its node driver: one `Amazonec2Config` per machine
 * pool, the machines in the lab's VPC on the site, with public addresses (they reach Rancher over
 * the internet). No AWS cloud provider yet: LoadBalancer Services get no load balancer.
 */
export class Ec2Cluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    readonly provider: k8s.Provider;
    readonly clusterId: pulumi.Output<string>;

    constructor(name: string, args: Ec2ClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:Ec2Cluster", name, {}, opts);
        const built = nodeDriverCluster(this, name, args, args.pools, (o, clusterName) => ({
            kind: "Amazonec2Config",
            machineConfigs: args.pools.map(pool => new rke_machine_config.v1.Amazonec2Config(`${name}/${pool.name}`, {
                metadata: { name: `${clusterName}-${pool.name}`, namespace: NS },
                region: args.region,
                zone: pool.zone,
                vpcId: args.vpcId,
                subnetId: pool.subnetId,
                securityGroup: [args.securityGroup],
                securityGroupReadonly: true,
                instanceType: pool.instanceType,
                rootSize: String(toGiB(pool.disk)),
                volumeType: "gp3",
                ami: pool.ami,
                sshUser: pool.sshUser,
                userdata: pool.userData,
                // The node driver's format: key,value,key,value.
                tags: Object.entries(args.tags).flat().join(","),
                // IMDSv2 only.
                httpEndpoint: "enabled",
                httpTokens: "required",
            }, o)),
        }));
        this.cluster = built.cluster;
        this.provider = built.provider;
        this.clusterId = built.clusterId;
        this.registerOutputs({});
    }
}
