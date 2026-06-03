import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { HarvesterKubeconfig } from "@suse-tmm/common";
import { loadConfig } from "./config";
import { provisionVmOnHarvester } from "./infrastructure";
import { HelmApp } from "@suse-tmm/common";

const cfg = loadConfig();

const downloadImages = cfg.vm.imageId === undefined;
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

const imageDetails = {
    id: "default/leap16-base.x86_64",
    storageClassName: "lh-068b8a62-b9bf-4648-bb48-c43b072d9e06",
};

const networkName = "tenant-broadline-network";

// Provision VM on Harvester
const { vm } = provisionVmOnHarvester({
    harvesterKubeconfig: harvesterKubeconfig.kubeconfig,
    vmName: "broadline-app-02",
    vmNamespace: "tenant-broadline-logistics",
    vmConfig: cfg.vm,
    vmImage: imageDetails,
    network: {
        namespace: "tenant-broadline-logistics",
        name: networkName,
        macAddress: cfg.vm.macAddress,
    },
});

// Stack outputs
export const harvesterKubeconfigOutput = harvesterKubeconfig.kubeconfig;
