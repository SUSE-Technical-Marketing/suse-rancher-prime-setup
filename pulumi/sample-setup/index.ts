import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import { VmImageArgs } from "@suse-tmm/harvester/src/base/vmimage";
import * as kubernetes from "@pulumi/kubernetes";
import { RancherManagerInstall } from "@suse-tmm/rancher";
import { installUIPluginRepo, defaultUIPluginRepos, RancherUIPlugin } from "@suse-tmm/rancher";
import { HarvesterKubeconfig, RancherLoginInputs } from "@suse-tmm/utils";
import { HarvesterCloudProvider } from "@suse-tmm/rancher/src/cloud/harvester";
import * as versions from "./versions"
import * as fleet from "./fleet";
import { RancherSetting } from "@suse-tmm/rancher/src/resources/setting";
import { ClusterRepo } from "@suse-tmm/rancher-crds";

export function provisionHarvester(clusterNetwork:string, downloadSuseImage: boolean, harvesterK8sProvider: kubernetes.Provider, sshUser: string, sshPubKey: string) : harvester.HarvesterBase {
    const images: VmImageArgs[] = []
    if (downloadSuseImage) {
        images.push({
            name: "opensuse-leap-15.6",
            displayName: "openSUSE Leap 15.6",
            url: "https://download.opensuse.org/repositories/Cloud:/Images:/Leap_15.6/images/openSUSE-Leap-15.6.x86_64-NoCloud.qcow2",
        },{
            name: "opensuse-leap-16.0",
            displayName: "openSUSE Leap 16.0",
            url: "https://download.opensuse.org/download/repositories/openSUSE:/Leap:/16.0:/Images/images/Leap-16.0-Minimal-VM.x86_64-Cloud.qcow2",
        });
    }
    const harvesterBase = new harvester.HarvesterBase("harvester-base", {
        clusterNetwork: clusterNetwork,
        extraImages: images,
        sshUser: sshUser,
        sshPublicKey: sshPubKey,
    }, { provider: harvesterK8sProvider });

    return harvesterBase;
}

const harvesterConfig = new pulumi.Config("harvester");
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
const certManagerVersion = certManagerConfig.get("version") || versions.CERT_MANAGER_VERSION;

const labConfig = new pulumi.Config("lab");
const domain = labConfig.get("domain");

const rancherConfig = new pulumi.Config("rancher");
const adminPassword = RancherManagerInstall.validateAdminPassword(rancherConfig.requireSecret("adminPassword"));
const skipBootstrap = rancherConfig.getBoolean("skipBootstrap") || false;
const rancherVmName = rancherConfig.require("vmName");
const rancherVersion = rancherConfig.get("version") || versions.RANCHER_VERSION;
const rancherLizEnabled = rancherConfig.getBoolean("lizEnabled") || false;


const harvesterUrl = pulumi.interpolate`https://${harvesterName}.${domain}`;
const downloadSuseImage = imageId === undefined ? true : false;
// If imageId is not provided, we will download the openSUSE Leap 15.6 image
let imageDetails: {id: pulumi.Output<string>, storageClassName: pulumi.Output<string>}

pulumi.log.info(`Lets Encrypt Environment: ${staging ? "Staging" : "Production"}, Email: ${letsEncryptEmail ? "Provided" : "Not Provided"}`);
pulumi.log.info(`Cloudflare API Key: ${cloudFlareApiKey ? "Provided" : "Not Provided"}`);

const harvesterKubeconfig = new HarvesterKubeconfig("harvester-kubeconfig", {
    rancher: {
        server: harvesterUrl,
        username: username,
        password: password,
        insecure: true, // Harvester normally has a self-signed cert
    },
    clusterId: "local",
});


const harvesterK8sProvider = new kubernetes.Provider("harvester-k8s", {
    kubeconfig: harvesterKubeconfig.kubeconfig,
});

const harvBase = provisionHarvester(clusterNetwork, downloadSuseImage, harvesterK8sProvider, sshUser, sshPubKey);
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

const rancherManager = new RancherManagerInstall("rancher-manager", {
    harvester: {

        kubeconfig: harvesterKubeconfig.kubeconfig,
        vmName: rancherVmName,
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
    hostname: rancherVmName,
    rancherVersion: versions.RANCHER_VERSION,
    traefikVersion: versions.TRAEFIK_VERSION,
    tls: {
        certManager: cloudFlareApiKey && letsEncryptEmail ? {
            version: versions.CERT_MANAGER_VERSION,
            cloudFlareApiToken: cloudFlareApiKey,
            letsEncryptEmail: letsEncryptEmail,
            wildcardDomain: `${rancherVmName}.${domain}`,
            staging: staging
        } : undefined,
    },
    adminPassword: adminPassword,
    skipBootstrap: skipBootstrap,
}, {
    dependsOn: [harvBase]
});

const rancherK8sProvider = new kubernetes.Provider("rancher-k8s", { kubeconfig: rancherManager.kubeconfig });
const repos = defaultUIPluginRepos({ provider: rancherK8sProvider, dependsOn: [rancherManager] });

const rancher: RancherLoginInputs = {
    server: rancherManager.rancherUrl,
    username: "admin",
    password: rancherManager.rancherAdminPassword,
    authToken: rancherManager.authToken,
    insecure: staging,
};

const plugins = [
    {name: "harvester", repoName: "rancher-ui-plugins", version: versions.HARVESTER_UIPLUGIN_VERSION },
    {name: "virtual-clusters", repoName: "virtual-clusters", version: versions.VIRTUAL_CLUSTERS_UIPLUGIN_VERSION },
    {name: "kubewarden", repoName: "rancher-ui-plugins", version: versions.KUBEWARDEN_UIPLUGIN_VERSION },
    {name: "sbomscanner-ui-ext", repoName: "security-ui", version: versions.SBOMSCANNER_UIPLUGIN_VERSION },
].map(plugin =>
    new RancherUIPlugin(plugin.name, {
        chartName: plugin.name,
        rancher: rancher,
        repoName: repos.get(plugin.repoName)!.metadata.name,
        version: plugin.version,
    })
);


new HarvesterCloudProvider("harvester-cloud", {
    rancherKubeconfig: rancherManager.kubeconfig,
    clusterName: harvesterName,
    harvester: {
        server: harvesterUrl,
        username: username,
        password: password,
        insecure: true, // Harvester normally has a self-signed cert
    },
    rancher: {
        server: rancherManager.rancherUrl,
        authToken: rancherManager.authToken,
        insecure: staging,
    },

}, { provider: rancherK8sProvider, dependsOn: plugins });

fleet.createFleetConfiguration(rancherManager.kubeconfig, rancher, { provider: rancherK8sProvider, dependsOn: [rancherManager] });

if (rancherLizEnabled) {
    const lizRepo = installUIPluginRepo("rancher-ai-liz", {
        gitRepo: "https://github.com/torchiaf/rancher-ai-ui",
        gitBranch: "gh-pages",
    }, { provider: rancherK8sProvider, dependsOn: [rancherManager] });

    new RancherUIPlugin("rancher-ai-ui", {
        chartName: "rancher-ai-ui",
        rancher: rancher,
        repoName: lizRepo.metadata.name,
        version: "0.1.40",
    });

    [
        { name: "ui-index", value: "https://releases.rancher.com/ui/ai-extension-shell-api-compatible-dev/index.html" },
        { name: "ui-dashboard-index", value: "https://releases.rancher.com/dashboard/ai-extension-shell-api-compatible-dev/index.html" },
        { name: "ui-offline-preferred", value: "false" }
    ].forEach(setting =>
        new RancherSetting(setting.name, {
            rancher: rancher,
            settingName: setting.name,
            settingValue: setting.value,
        }, {
            dependsOn: [rancherManager],
        })
    );
}

pulumi.all([harvesterKubeconfig.kubeconfig, rancherManager.kubeconfig]).apply(([harvkcfg, controlkcfg]) => {
    pulumi.log.info(`Harvester Kubeconfig: ${harvkcfg}`);
    pulumi.log.info(`Rancher Kubeconfig: ${controlkcfg}`);
});
