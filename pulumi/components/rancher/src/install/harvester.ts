import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import { BashRcLocal, cloudInit, DefaultUser, DisableIpv6, GuestAgent, IncreaseFileLimit, InstallK3s, KubeFirewall, NewUser, Packages, PackageUpdate, DhcpInterface } from "@suse-tmm/utils";

interface HarvesterNetwork {
    namespace: pulumi.Input<string>;
    name: pulumi.Input<string>;
    macAddress?: pulumi.Input<string>; // Optional, if not provided Harvester will generate a MAC address
}

interface KeyPair {
    publicKey: pulumi.Input<string>;
    privateKey: pulumi.Input<string>;
}

interface VmImage {
    id: pulumi.Input<string>;
    storageClassName: pulumi.Input<string>;
}

interface VmResources {
    cpu: pulumi.Input<number>;
    memory: pulumi.Input<string>;
    diskSize?: pulumi.Input<string>; // Optional, defaults to "100Gi"
}

export interface HarvesterVmArgs {
    network: HarvesterNetwork;
    vmImage: VmImage;
    vmName: string;
    vmResources?: VmResources; // Optional, defaults to { cpu: 2, memory: "6Gi" }
    vmNamespace?: string; // Optional, defaults to "harvester-public"
    sshUser: pulumi.Input<string>;
    keypair: KeyPair; // Contains public and private keys for SSH access
}

export function provisionHarvesterVm(args: HarvesterVmArgs, kubeconfig: pulumi.Input<string>, opts?: pulumi.ComponentResourceOptions): harvester.HarvesterVm {
    const harvesterVm = new harvester.HarvesterVm(args.vmName, {
        kubeconfig: kubeconfig,
        virtualMachine: {
            namespace: args.vmNamespace || "harvester-public",
            networkName: args.network.name,
            resources: {
                cpu: args.vmResources?.cpu || 2,
                memory: args.vmResources?.memory || "6Gi"
            },
            network: {
                name: args.network.name,
                namespace: args.network.namespace,
                macAddress: args.network.macAddress
            },
            disk: {
                name: "disk0",
                size: args.vmResources?.diskSize || "100Gi",
                imageId: args.vmImage.id,
                storageClassName: args.vmImage.storageClassName
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
                    sshAuthorizedKeys: [args.keypair.publicKey],
                }),
                PackageUpdate,
                Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),

                GuestAgent,
                IncreaseFileLimit,
                DhcpInterface("eth0"),
                DhcpInterface("eth1"),

                InstallK3s(false, "v1.34.3+k3s3"),
            ),
        }
    }, opts);

    return harvesterVm
}
