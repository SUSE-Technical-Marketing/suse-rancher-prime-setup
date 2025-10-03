import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import { VmImageArgs } from "@suse-tmm/harvester/src/base/vmimage";
import * as kubernetes from "@pulumi/kubernetes";
import { RancherManagerInstall } from "@suse-tmm/rancher";
import { installUIPluginRepo, RancherUIPlugin } from "@suse-tmm/rancher";
import { kubeconfig } from "@suse-tmm/utils";
import { HarvesterCloudProvider } from "@suse-tmm/rancher/src/cloud/harvester";

export function provisionHarvester(clusterNetwork:string, downloadSuseImage: boolean, kubeconfig: kubeconfig.RancherKubeconfig) {
    const images: VmImageArgs[] = []
    if (downloadSuseImage) {
        images.push({
            name: "opensuse-leap-15.6",
            displayName: "openSUSE Leap 15.6",
            url: "https://download.opensuse.org/repositories/Cloud:/Images:/Leap_15.6/images/openSUSE-Leap-15.6.x86_64-NoCloud.qcow2",
        });
    }

    const harvesterBase = new harvester.HarvesterBase("harvester-base", {
        kubeconfig: kubeconfig.kubeconfig,
        clusterNetwork: clusterNetwork,
        extraImages: images,
    });

    return harvesterBase;
}

const harvesterConfig = new pulumi.Config("harvester");
const harvesterUrl = harvesterConfig.require("url");
const username = harvesterConfig.require("username");
const password = harvesterConfig.requireSecret("password");
const clusterNetwork = harvesterConfig.get("clusterNetwork") || "mgmt";

const harvesterName = harvesterConfig.get("name") || "harvester";
const vmConfig = new pulumi.Config("vm");
const sshUser = vmConfig.require("sshUser");
const sshPubKey = vmConfig.require("sshPubKey");
const sshPrivKey = vmConfig.requireSecret("sshPrivKey");
const cpu = vmConfig.getNumber("cpu") || 2;
const memory = vmConfig.get("memory") || "6Gi";
const diskSize = vmConfig.get("diskSize") || "100Gi";
const macAddress = vmConfig.get("macAddress")
const imageId = vmConfig.get("imageId")
const imageStorageClass = vmConfig.get("imageStorageClass") || "longhorn-single"


const certManagerConfig = new pulumi.Config("cert-manager");
const staging = (certManagerConfig.get("staging") || "true") === "true"; // Default to true if not provided
const letsEncryptEmail = certManagerConfig.get("letsEncryptEmail");
const cloudFlareApiKey = certManagerConfig.get("cloudflareApiKey");

const labConfig = new pulumi.Config("lab");
const domain = labConfig.get("domain");

const rancherConfig = new pulumi.Config("rancher");
const adminPassword = rancherConfig.requireSecret("adminPassword");
const skipBootstrap = rancherConfig.getBoolean("skipBootstrap") || false;

pulumi.log.info(`Lets Encrypt Environment: ${staging ? "Staging" : "Production"}, Email: ${letsEncryptEmail ? "Provided" : "Not Provided"}`);
pulumi.log.info(`Cloudflare API Key: ${cloudFlareApiKey ? "Provided" : "Not Provided"}`);

const harvesterKubeconfig = new kubeconfig.RancherKubeconfig("harvester-kubeconfig", {
    url: harvesterUrl,
    username: username,
    password: password,
    clusterName: "local",
    insecure: true, // Harvester normally has a self-signed cert
});

// If imageId is not provided, we will download the openSUSE Leap 15.6 image
const downloadSuseImage = imageId === undefined ? true : false;
let imageDetails: {id: pulumi.Output<string>, storageClassName: pulumi.Output<string>}

const harvBase = provisionHarvester(clusterNetwork, downloadSuseImage, harvesterKubeconfig);
const nw = harvBase.networks.get("backbone-vlan")!;

if (downloadSuseImage) {
    const image = harvBase.images.get("opensuse-leap-15.6")!;
    imageDetails = {
        id: image.id,
        storageClassName: image.status.storageClassName
    };
} else {
    imageDetails = {
        id: pulumi.output(imageId ? imageId : ""),
        storageClassName: pulumi.output(imageStorageClass)
    }
}

RancherManagerInstall.validateAdminPassword(adminPassword);

const rancherManager = new RancherManagerInstall("rancher-manager", {
    harvester: {

        kubeconfig: harvesterKubeconfig.kubeconfig,
        vmName: "control-tower",
        vmNamespace: "harvester-public",
        vmResources: {
            cpu: cpu,
            memory: memory,
            diskSize: diskSize
        },
        vmImage: {
            id: imageDetails.id,
            storageClassName: imageDetails.storageClassName
        },
        sshUser: sshUser,
        keypair: {
            publicKey: sshPubKey,
            privateKey: sshPrivKey,
        },
        network: {
            namespace: nw.metadata.namespace,
            name: nw.metadata.name,
            macAddress: macAddress, // Optional, if not provided Harvester will generate a MAC address
        }
    },
    domain: domain,
    hostname: "control-tower",
    tls: {
        certManager: cloudFlareApiKey && letsEncryptEmail ? {
            version: "v1.17.2",
            cloudFlareApiToken: cloudFlareApiKey,
            letsEncryptEmail: letsEncryptEmail,
            wildcardDomain: `control-tower.${domain}`,
            staging: staging
        } : undefined,
    },
    adminPassword: adminPassword,
    skipBootstrap: skipBootstrap,
}, {
    dependsOn: [harvBase]
});

const rancherK8sProvider = new kubernetes.Provider("rancher-k8s", { kubeconfig: rancherManager.kubeconfig });
const repo = installUIPluginRepo({ provider: rancherK8sProvider, dependsOn: [rancherManager] });
const uiPlugin = new RancherUIPlugin("harvester", {
    chartName: "harvester",
    rancher: {
        rancherServer: rancherManager.rancherUrl,
        username: "admin",
        password: rancherManager.rancherAdminPassword
    },
    repoName: repo.metadata.name,
    version: "1.5.2"
});

new HarvesterCloudProvider("harvester-cloud", {
    rancherKubeconfig: rancherManager.kubeconfig,
    clusterName: harvesterName,
    harvester: {
        rancherServer: harvesterUrl,
        username: username,
        password: password,
        insecure: true, // Harvester normally has a self-signed cert
    }
}, { provider: rancherK8sProvider, dependsOn: [uiPlugin] });

// pulumi.all([harvesterKubeconfig.kubeconfig, rancherManager.kubeconfig]).apply(([harvkcfg, controlkcfg]) => {
//     // pulumi.log.info(`Harvester Kubeconfig: ${harvkcfg}`);
//     // pulumi.log.info(`control-tower Kubeconfig: ${controlkcfg}`);
// });
