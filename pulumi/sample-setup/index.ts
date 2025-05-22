import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as harvester from "@suse-tmm/harvester";
import * as rancher from "@suse-tmm/rancher-kubeconfig";
import { BashRcLocal, cloudInit, DefaultUser, DisableIpv6, GuestAgent, IncreaseFileLimit, InstallK3s, KubeFirewall, NewUser, Packages, PackageUpdate } from "@suse-tmm/utils";


export function provisionHarvester() {
    const config = new pulumi.Config("harvester");
    const harvesterUrl = config.require("url");
    const username = config.require("username");
    const password = config.requireSecret("password");

    const kubeconfig = new rancher.RancherKubeconfig("harvesterKubeconfig", {
        url: harvesterUrl,
        username: username,
        password: password,
        clusterName: "local",
        insecure: true, // Harvester normally has a self-signed cert
    });

    const harvesterBase = new harvester.HarvesterBase("harvesterBase", {
        kubeconfig: kubeconfig.kubeconfig,
        extraImages: [
            {
                name: "fedora-cloud-42",
                displayName: "Fedora Cloud 42",
                url: "https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
            }
        ]
    });

    const openSuseImage = harvesterBase.images.apply(images => images.get("opensuse-leap-15.6")!);
    const network = harvesterBase.networks.apply(networks => networks.get("backbone-vlan")!);
    const harvesterVm = new harvester.HarvesterVm("control-tower", {
        kubeconfig: kubeconfig.kubeconfig,
        virtualMachine: {
            namespace: "harvester-public",
            resources: {
                cpu: 2,
                memory: "4Gi"
            },
            network: {
                name: network.metadata.name,
                namespace: network.metadata.namespace
            },
            disk: {
                name: "disk0",
                size: "10Gi",
                image: openSuseImage
            },
            cloudInit: cloudInit(
                BashRcLocal,
                KubeFirewall,
                DisableIpv6,
                DefaultUser,
                NewUser({
                    name: "jeroen",
                    password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
                    sudo: "ALL=(ALL) NOPASSWD:ALL",
                    sshAuthorizedKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBSE68VYUiwL5a8xcmv34RZ1OYnrEcRBe4NaeKpE/twU jeroen@hierynomus.com",
                        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDmt6+SsXzLoRptifmSKlyjq6grRf4Yb1f2g0Etn7PKUK0LLKO3qZmSEgDwhohALXU7ZhSMVttYgLCjtFd4kG/JEdJVkGSqppLekgpc/T3yG8K3sO78UBdWtnLVY/6MtIHC1GHsAikTuPIJfIqftIk1RZwLKfIIgkT3HQAl9Kzn45QCVj4RrOhekHmqlgePrasTe1HKFRjQ/cuM6cqHSaPNWHrgshlci5BVTS6hqjNxeW/Rb/X4vDcvs/5glRvd0M3ESr1Aii5fhATzHSCGUje2U91ztRDvXdZQNsxQGPP1oTVTRa0oxKutpZee5lMEUjwU6hzoAx3jxPehayFjWJh"
                    ]
                }),
                PackageUpdate,
                Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),

                GuestAgent,
                IncreaseFileLimit,
                InstallK3s
            ),
        }
    });

    pulumi.all([kubeconfig.kubeconfig]).apply(([kubeconfig]) => {
        pulumi.log.info(kubeconfig);
    });
}

provisionHarvester();
