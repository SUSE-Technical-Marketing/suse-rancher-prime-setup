import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { HarvesterKubeconfig } from "@suse-tmm/common";
import { loadConfig } from "./config";
import { provisionHarvester } from "./harvester-base";

const cfg = loadConfig();

const harvesterUrl = pulumi.interpolate`https://${cfg.harvester.name}.${cfg.lab.domain}`;

// Connect to Harvester
const harvesterKubeconfig = new HarvesterKubeconfig("harvester-kubeconfig", {
    rancher: {
        server: harvesterUrl,
        username: cfg.harvester.username,
        password: cfg.harvester.password,
        insecure: true,
    },
    clusterId: "local",
});

const harvesterK8sProvider = new kubernetes.Provider("harvester-k8s", {
    kubeconfig: harvesterKubeconfig.kubeconfig,
});

// Provision Harvester base resources
const harvBase = provisionHarvester({
    clusterNetwork: cfg.harvester.clusterNetwork,
    sshUser: cfg.lab.sshUser,
    sshPubKey: cfg.lab.sshPubKey,
    vlan: cfg.vlan,
    downloadImages: true,
}, harvesterK8sProvider);

// Stack outputs
export const harvesterKubeconfigOutput = harvesterKubeconfig.kubeconfig;
