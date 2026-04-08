import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { RancherManagerInstall, BootstrapAdminPassword } from "@suse-tmm/rancher";
import { HarvesterKubeconfig, KubeWait, noProvider, RancherLoginInputs } from "@suse-tmm/utils";
import { HarvesterCloudProvider } from "@suse-tmm/rancher/src/cloud/harvester";
import * as versions from "./versions";
import { loadConfig } from "./config";
import { provisionHarvester, resolveImage } from "./harvester-base";
import { provisionK3sOnHarvester } from "./infrastructure";
import { installPlugins, installLizExtension } from "./rancher-plugins";
import { createFleetConfiguration } from "./fleet";

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

// Provision Harvester base resources
const harvBase = provisionHarvester({
    clusterNetwork: cfg.harvester.clusterNetwork,
    sshUser: cfg.vm.sshUser,
    sshPubKey: cfg.vm.sshPubKey,
    vlan: cfg.vlan.enabled,
    downloadImages,
}, harvesterK8sProvider);

const imageDetails = resolveImage(harvBase, cfg.vm);

const networkName = cfg.vlan.enabled ? "vlan10" : "backbone-vlan";


// Provision VM with K3s on Harvester
const { vm, kubeconfig: k3sKubeconfig } = provisionK3sOnHarvester({
    harvesterKubeconfig: harvesterKubeconfig.kubeconfig,
    vmName: cfg.rancher.vmName,
    vmNamespace: "harvester-public",
    vmConfig: cfg.vm,
    vmImage: imageDetails,
    network: {
        namespace: "default",
        name: harvBase.networks[networkName].metadata.name,
        macAddress: cfg.vm.macAddress,
    },
    k3sVersion: versions.K3S_VERSION,
    insecure: cfg.certManager.staging,
}, { dependsOn: [harvBase] });

// Install Rancher Manager on the K3s cluster
const rancherManager = new RancherManagerInstall("rancher-manager", {
    kubeconfig: k3sKubeconfig,
    domain: cfg.lab.domain,
    hostname: cfg.rancher.vmName,
    rancherVersion: cfg.rancher.version,
    tls: {
        certManager: cfg.certManager.cloudflareApiKey && cfg.certManager.letsEncryptEmail ? {
            version: cfg.certManager.version,
            cloudFlareApiToken: cfg.certManager.cloudflareApiKey,
            letsEncryptEmail: cfg.certManager.letsEncryptEmail,
            wildcardDomain: `${cfg.rancher.vmName}.${cfg.lab.domain}`,
            staging: cfg.certManager.staging,
        } : undefined,
    },
    adminPassword: cfg.rancher.adminPassword,
    skipBootstrap: cfg.rancher.skipBootstrap,
}, { dependsOn: [vm] });

const rancherK8sProvider = new kubernetes.Provider("rancher-k8s", { kubeconfig: rancherManager.kubeconfig });
const rancherOpts: pulumi.ResourceOptions = { provider: rancherK8sProvider, dependsOn: [rancherManager] };

const kw = new KubeWait("wait-for-rancherinstallation", {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    name: "gitrepos.fleet.cattle.io",
    kubeconfig: rancherManager.kubeconfig,
    condition: "Established",
}, noProvider(rancherOpts));

const bootstrapPassword = new BootstrapAdminPassword("rancher-bootstrap-password", {
    kubeconfig: rancherManager.kubeconfig,
    adminPassword: cfg.rancher.adminPassword,
    rancherUrl: rancherManager.rancherUrl,
    insecure: cfg.certManager.staging || false,
}, {
    dependsOn: [kw],
});

const rancher: RancherLoginInputs = {
    server: rancherManager.rancherUrl,
    username: "admin",
    password: bootstrapPassword.password,
    insecure: cfg.certManager.staging,
};

// UI Plugins
const plugins = installPlugins(rancher, {...rancherOpts, dependsOn: [bootstrapPassword]});

// Harvester Cloud Provider
new HarvesterCloudProvider("harvester-cloud", {
    rancherKubeconfig: rancherManager.kubeconfig,
    clusterName: cfg.harvester.name,
    harvester: {
        server: harvesterUrl,
        username: cfg.harvester.username,
        password: cfg.harvester.password,
        insecure: true,
    },
    rancher,
}, { provider: rancherK8sProvider, dependsOn: plugins });

// Fleet GitOps
createFleetConfiguration(
    { lab: cfg.lab, certManager: cfg.certManager },
    rancherManager.kubeconfig,
    {...rancherOpts, dependsOn: [bootstrapPassword]},
);

// Liz AI Extension (optional)
if (cfg.rancher.lizEnabled) {
    installLizExtension(rancher, rancherManager, {...rancherOpts, dependsOn: [bootstrapPassword]});
}

// Stack outputs
export const harvesterKubeconfigOutput = harvesterKubeconfig.kubeconfig;
export const rancherKubeconfigOutput = rancherManager.kubeconfig;
export const rancherUrl = rancherManager.rancherUrl;
