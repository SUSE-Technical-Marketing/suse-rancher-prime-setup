import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as harvester from "@suse-tmm/harvester";
import * as kubeconfig from "@suse-tmm/kubeconfig";
import { BashRcLocal, cloudInit, DefaultUser, DisableIpv6, GuestAgent, IncreaseFileLimit, InstallK3s, KubeFirewall, NewUser, Packages, PackageUpdate } from "@suse-tmm/utils";
import { RancherManagerInstall } from "@suse-tmm/rancher-install";

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

interface VmArgs {
    sshUser: string;
    sshPubKey: string;
}

export function provisionControlTower(harvesterBase: harvester.HarvesterBase, args: VmArgs, kubeconfig: kubeconfig.RancherKubeconfig) {
    const openSuseImage = harvesterBase.images.get("opensuse-leap-15.6")!;
    const network = harvesterBase.networks.get("backbone-vlan")!;
    const harvesterVm = new harvester.HarvesterVm("control-tower", {
        kubeconfig: kubeconfig.kubeconfig,
        virtualMachine: {
            namespace: "harvester-public",
            resources: {
                cpu: 2,
                memory: "6Gi"
            },
            network: {
                name: network.metadata.name,
                namespace: network.metadata.namespace
            },
            disk: {
                name: "disk0",
                size: "100Gi",
                image: openSuseImage
            },
            cloudInit: cloudInit(
                BashRcLocal,
                KubeFirewall,
                DisableIpv6,
                DefaultUser,
                NewUser({
                    name: args.sshUser,
                    password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
                    sudo: "ALL=(ALL) NOPASSWD:ALL",
                    sshAuthorizedKeys: [args.sshPubKey],
                }),
                PackageUpdate,
                Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),

                GuestAgent,
                IncreaseFileLimit,
                InstallK3s
            ),
        }
    });

    return harvesterVm
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

pulumi.log.info(`Lets Encrypt Email: ${letsEncryptEmail ? "Provided" : "Not Provided"}`);
pulumi.log.info(`Cloudflare API Key: ${cloudFlareApiKey ? "Provided" : "Not Provided"}`);

const cfg = new kubeconfig.RancherKubeconfig("harvester-kubeconfig", {
    url: harvesterUrl,
    username: username,
    password: password,
    clusterName: "local",
    insecure: true, // Harvester normally has a self-signed cert
});

const harvBase = provisionHarvester(cfg);
const vmi = provisionControlTower(harvBase, {
    sshUser: sshUser,
    sshPubKey: sshPubKey
}, cfg);
const ip = vmi.vmIpAddress;

const controlTowerKubeconfig = new kubeconfig.RemoteKubeconfig("control-tower-kubeconfig", {
    hostname: ip,
    username: sshUser,
    privKey: sshPrivKey,
    path: "/etc/rancher/k3s/k3s.yaml",
    updateServerAddress: true, // Patch the kubeconfig to use the correct server address
});

new RancherManagerInstall("rancher-manager", {
    kubeconfig: controlTowerKubeconfig.kubeconfig,
    domain: domain,
    hostname: "control-tower",
    installIngress: true, // Install Ingress controller
    tls: {
        certManager: cloudFlareApiKey && letsEncryptEmail ? {
            version: "v1.17.2",
            cloudFlareApiToken: cloudFlareApiKey,
            letsEncryptEmail: letsEncryptEmail,
            wildcardDomain: `control-tower.${domain}`,
        } : undefined,
    }
});


pulumi.all([cfg.kubeconfig, controlTowerKubeconfig.kubeconfig]).apply(([harvkcfg, controlkcfg]) => {
    pulumi.log.info(`Harvester Kubeconfig: ${harvkcfg}`);
    pulumi.log.info(`Control Tower Kubeconfig: ${controlkcfg}`);
});
