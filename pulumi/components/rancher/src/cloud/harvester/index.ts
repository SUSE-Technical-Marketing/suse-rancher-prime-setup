import * as pulumi from "@pulumi/pulumi";
import {provisioning, management } from "@suse-tmm/rancher-crds";
import { HarvesterSetting } from "@suse-tmm/harvester";
import {harvesterhci} from "@suse-tmm/harvester-crds";
import { ClusterRegistrationToken } from "./clusterregistrationtoken";
import { KubeWait, noProvider, RancherLogin, RancherLoginInputs } from "@suse-tmm/utils";
import { RancherSetting } from "../..//resources/setting";
import { HarvesterCloudCredential } from "./cloudcredential";

export interface HarvesterCloudArgs {
    clusterName: pulumi.Input<string>;
    rancherKubeconfig: pulumi.Input<string>; // Kubeconfig to access the Rancher cluster

    harvester: RancherLoginInputs;
    rancher: RancherLoginInputs;
}

export class HarvesterCloudProvider extends pulumi.ComponentResource {
    constructor(name: string, args: HarvesterCloudArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:rancher:harvester-cloud-provider", name, {}, opts);

        const myOpts = { ...opts, parent: this };
        const cluster = new provisioning.Cluster("harvester-cluster", {
            metadata: {
                name: args.clusterName,
                namespace: "fleet-default", // Important: If a cluster lands in another namespace, fleet will start doing weird things.
                annotations: {
                    "pulumi.com/waitFor": "condition=Created"
                },
                labels: {
                    "provider.cattle.io": "harvester"
                }
            },
            spec: {

            }
        }, myOpts);

        const token = new ClusterRegistrationToken("harvester-cluster-token", {
            clusterName: cluster.status.clusterName,
            rancherKubeconfig: args.rancherKubeconfig,
        }, noProvider(myOpts));

        // const harvesterAuth = new RancherLogin("harvester-auth", { ...args.harvester, insecure: true }, noProvider(myOpts)).getAuth();
        // const harvesterAuthSetting = new harvesterhci.v1beta1.Setting("harvester-cluster-url-setting", {
        //     metadata: {
        //         name: "cluster-registration-url"
        //     },
        //     value: token.token
        // }, noProvider(myOpts));
        const harvesterAuthSetting = new HarvesterSetting("harvester-auth-setting", {
            harvester: args.harvester,
            settingName: "cluster-registration-url",
            settingValue: token.token
        }, noProvider(myOpts));

        const kw = new KubeWait("cluster-registration-wait", {
            kubeconfig: args.rancherKubeconfig,
            apiVersion: "provisioning.cattle.io/v1",
            kind: "Cluster",
            name: args.clusterName,
            namespace: "fleet-default",
            condition: "Connected",
            timeoutSeconds: 600,
            pollSeconds: 10,
        }, noProvider({...myOpts, dependsOn: [harvesterAuthSetting] }));

        new HarvesterCloudCredential("harvester-cloud-credential", {
            rancher: args.rancher,
            clusterName: args.clusterName,
        }, {...myOpts, dependsOn: [kw] });
    }
}
