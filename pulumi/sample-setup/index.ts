import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import * as kubeconfig from "@suse-tmm/kubeconfig";
import { RancherManagerInstall } from "@suse-tmm/rancher";

export function provisionHarvester(kubeconfig: kubeconfig.RancherKubeconfig) {
    const harvesterBase = new harvester.HarvesterBase("harvester-base", {
        kubeconfig: kubeconfig.kubeconfig,
        extraImages: [
            // {
            //     name: "fedora-cloud-42",
            //     displayName: "Fedora Cloud 42",
            //     url: "https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
            // }
        ]
    });

    return harvesterBase;
}

const harvesterConfig = new pulumi.Config("harvester");
const harvesterUrl = harvesterConfig.require("url");
const username = harvesterConfig.require("username");
const password = harvesterConfig.requireSecret("password");
const vmConfig = new pulumi.Config("vm");
const sshUser = vmConfig.require("sshUser");
const sshPubKey = vmConfig.require("sshPubKey");
const sshPrivKey = vmConfig.requireSecret("sshPrivKey");
const certManagerConfig = new pulumi.Config("cert-manager");
const letsEncryptEmail = certManagerConfig.get("letsEncryptEmail");
const cloudFlareApiKey = certManagerConfig.get("cloudflareApiKey");
const labConfig = new pulumi.Config("lab");
const domain = labConfig.get("domain");
const rancherConfig = new pulumi.Config("rancher");
const adminPassword = rancherConfig.requireSecret("adminPassword");

pulumi.log.info(`Lets Encrypt Email: ${letsEncryptEmail ? "Provided" : "Not Provided"}`);
pulumi.log.info(`Cloudflare API Key: ${cloudFlareApiKey ? "Provided" : "Not Provided"}`);

const harvesterKubeconfig = new kubeconfig.RancherKubeconfig("harvester-kubeconfig", {
    url: harvesterUrl,
    username: username,
    password: password,
    clusterName: "local",
    insecure: true, // Harvester normally has a self-signed cert
});

const harvBase = provisionHarvester(harvesterKubeconfig);

const nw = harvBase.networks.get("backbone-vlan")!;
const image = harvBase.images.get("opensuse-leap-15.6")!;

const rancherManager = new RancherManagerInstall("rancher-manager", {
    harvester: {
        kubeconfig: harvesterKubeconfig.kubeconfig,
        vmName: "control-tower",
        vmNamespace: "harvester-public",
        vmImage: {
            id: image.id,
            storageClassName: image.status.storageClassName
        },
        sshUser: sshUser,
        keypair: {
            publicKey: sshPubKey,
            privateKey: sshPrivKey,
        },
        network: {
            namespace: nw.metadata.namespace,
            name: nw.metadata.name,
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
        } : undefined,
    },
    adminPassword: adminPassword,
}, {
    dependsOn: [harvBase]
});


// pulumi.all([harvesterKubeconfig.kubeconfig, rancherManager.kubeconfig]).apply(([harvkcfg, controlkcfg]) => {
//     // pulumi.log.info(`Harvester Kubeconfig: ${harvkcfg}`);
//     // pulumi.log.info(`control-tower Kubeconfig: ${controlkcfg}`);
// });
