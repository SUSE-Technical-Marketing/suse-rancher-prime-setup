import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import * as kubernetes from "@pulumi/kubernetes";
import {
    BashRcLocal, DefaultUser, DisableIpv6, GuestAgent,
    IncreaseFileLimit, KubeFirewall, LonghornReqs, NewUser,
    Packages, PackageUpdate,
} from "@suse-tmm/utils";
import { VmConfig } from "./config";
import { HelmApp } from "@suse-tmm/common";

function defaultStorageClasses(): harvester.StorageClassArgs[] {
    return [{
        name: "longhorn-single",
        provisioner: "driver.longhorn.io",
        parameters: {
            numberOfReplicas: "1",
            migratable: "true",
            staleReplicaTimeout: "30",
        },
    }];
}

function defaultNetworks(clusterNetwork: string): harvester.NetworkArgs[] {
    return [{
        name: "backbone-vlan",
        annotations: {
            "network.harvesterhci.io/clusternetwork": clusterNetwork,
            "network.harvesterhci.io/ready": "true",
            "network.harvesterhci.io/type": "UntaggedNetwork",
        },
        config: `{"cniVersion":"0.3.1","name":"backbone","type":"bridge","bridge":"${clusterNetwork}-br","promiscMode":true,"ipam":{}}`,
    }];
}

function defaultImages(downloadImages: boolean): harvester.VmImageArgs[] {
    if (!downloadImages) return [];
    return [{
        name: "opensuse-leap-15.6",
        displayName: "openSUSE Leap 15.6",
        url: "https://download.opensuse.org/repositories/Cloud:/Images:/Leap_15.6/images/openSUSE-Leap-15.6.x86_64-NoCloud.qcow2",
    }, {
        name: "opensuse-leap-16.0",
        displayName: "openSUSE Leap 16.0",
        url: "https://download.opensuse.org/download/repositories/openSUSE:/Leap:/16.0:/Images/images/Leap-16.0-Minimal-VM.x86_64-Cloud.qcow2",
    }];
}

function defaultCloudInitTemplates(sshUser: string, sshPubKey: string): harvester.CloudInitTemplateArgs[] {
    return [{
        name: "opensuse-full-node",
        cloudInit: [
            BashRcLocal,
            KubeFirewall,
            DisableIpv6,
            IncreaseFileLimit,
            DefaultUser,
            PackageUpdate,
            Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),
            LonghornReqs,
            GuestAgent,
            NewUser({
                name: sshUser,
                sudo: "ALL=(ALL) NOPASSWD:ALL",
                sshAuthorizedKeys: [sshPubKey],
                password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
            }),
        ],
    }];
}

export function provisionHarvester(
    cfg: { clusterNetwork: string; sshUser: string; sshPubKey: string; downloadImages: boolean, vlan: boolean },
    provider: kubernetes.Provider,
): harvester.HarvesterBase {
    const storageClasses = defaultStorageClasses();
    const images = defaultImages(cfg.downloadImages);
    const networks = defaultNetworks(cfg.clusterNetwork);
    const addons: harvester.HarvesterAddonInputs[] = [];
    const pools: harvester.PoolArgs[] = [];

    let deps = [];
    if (cfg.vlan) {
        networks.push({
            name: "vlan10",
            annotations: {
                "network.harvesterhci.io/clusternetwork": cfg.clusterNetwork,
                "network.harvesterhci.io/ready": "true",
                "network.harvesterhci.io/type": "L2VlanNetwork",
            },
            config: `{"cniVersion":"0.3.1","name":"vlan10","type":"bridge","bridge":"${cfg.clusterNetwork}-br","vlan":10,"promiscMode":true,"ipam":{}}`,
        });

        addons.push({
            addonName: "harvester-vm-dhcp-controller",
            chart: "harvester-vm-dhcp-controller",
            repo: "https://charts.harvesterhci.io",
            version: "1.7.1",
            enabled: true,
            labels: {
                "addon.harvesterhci.io/experimental": "true",
            },
        });

        pools.push({
            name: "vlan10-pool",
            namespace: "default",
            serverIp: "10.29.10.2",
            cidr: "10.29.10.0/24",
            rangeStart: "10.29.10.10",
            rangeEnd: "10.29.10.50",
            gateway: "10.29.10.1",
            dnsServers: ["10.29.20.1", "8.8.8.8", "8.8.4.4"],
            domain: "lab.geeko.me",
            networkName: "vlan10",
            networkNamespace: "default",
        });

        const dns = new HelmApp("harvester-dns-controller", {
            retainOnDelete: false,
            chart: "oci://ghcr.io/hierynomus/harvester-dns-controller/charts/harvester-dns-controller",
            version: "0.2.0",
            namespace: "harvester-system",
            values: {
                dns: {
                    backend: "routeros",
                    host: "10.29.10.1",
                    username: "admin",
                    password: '!nfiniteP0wer',
                    useTls: false,
                    tlsVerify: false,
                    domain: "lab.geeko.me"
                }
            }
        }, { provider });
        deps.push(dns);
    }

    return new harvester.HarvesterBase("harvester-base", {
        storageClasses,
        networks,
        images: images.length > 0 ? {
            definitions: images,
            storageClassName: storageClasses[0].name,
        } : undefined,
        cloudInitTemplates: defaultCloudInitTemplates(cfg.sshUser, cfg.sshPubKey),
        addons,
        ipPools: pools,
    }, { provider, dependsOn: deps });
}

export function resolveImage(
    harvBase: harvester.HarvesterBase,
    vmConfig: VmConfig,
): { id: pulumi.Output<string>; storageClassName: pulumi.Output<string> } {
    if (vmConfig.imageId) {
        return {
            id: pulumi.output(vmConfig.imageId),
            storageClassName: pulumi.output(vmConfig.imageStorageClass),
        };
    }
    const image = harvBase.images["opensuse-leap-15.6"];
    return {
        id: image.id,
        storageClassName: image.status.storageClassName,
    };
}
