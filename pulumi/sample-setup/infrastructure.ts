import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import * as command from "@pulumi/command";
import { RemoteKubeconfig } from "@suse-tmm/utils";
import {
    BashRcLocal, cloudInit, DefaultUser, DisableIpv6, GuestAgent,
    IncreaseFileLimit, InstallK3s, KubeFirewall, NewUser, Packages,
    PackageUpdate, DhcpInterface,
} from "@suse-tmm/utils";
import { VmConfig } from "./config";

export interface HarvesterVmInfraArgs {
    harvesterKubeconfig: pulumi.Input<string>;
    vmName: string;
    vmNamespace?: string;
    vmConfig: VmConfig;
    vmImage: {
        id: pulumi.Input<string>;
        storageClassName: pulumi.Input<string>;
    };
    network: {
        namespace: string;
        name: pulumi.Input<string>;
        macAddress?: string;
    };
    k3sVersion: string;
    insecure: boolean;
}

export interface HarvesterVmInfraResult {
    vm: harvester.HarvesterVm;
    kubeconfig: pulumi.Output<string>;
}

export function provisionK3sOnHarvester(
    args: HarvesterVmInfraArgs,
    opts?: pulumi.ResourceOptions,
): HarvesterVmInfraResult {
    const vm = new harvester.HarvesterVm(args.vmName, {
        kubeconfig: args.harvesterKubeconfig,
        virtualMachine: {
            namespace: args.vmNamespace || "harvester-public",
            networkName: args.network.name,
            resources: {
                cpu: args.vmConfig.cpu,
                memory: args.vmConfig.memory,
            },
            network: {
                name: args.network.name,
                namespace: args.network.namespace,
                macAddress: args.network.macAddress,
            },
            disk: {
                name: "disk0",
                size: args.vmConfig.diskSize,
                imageId: args.vmImage.id,
                storageClassName: args.vmImage.storageClassName,
            },
            cloudInit: cloudInit(
                BashRcLocal,
                KubeFirewall,
                DisableIpv6,
                DefaultUser,
                NewUser({
                    name: args.vmConfig.sshUser,
                    password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
                    sudo: "ALL=(ALL) NOPASSWD:ALL",
                    sshAuthorizedKeys: [args.vmConfig.sshPubKey],
                }),
                PackageUpdate,
                Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),
                GuestAgent,
                IncreaseFileLimit,
                DhcpInterface("eth0"),
                DhcpInterface("eth1"),
                InstallK3s(true, args.k3sVersion),
            ),
        },
    }, opts);

    const waitForCloudInit = new command.remote.Command("wait-cloudinit", {
        connection: {
            host: vm.vmIpAddress,
            user: args.vmConfig.sshUser,
            privateKey: args.vmConfig.sshPrivKey,
            dialErrorLimit: 20,
            perDialTimeout: 30,
        },
        create: "sudo cloud-init status --wait || (sudo cat /var/log/cloud-init-output.log && exit 1)",
    }, { ...opts, dependsOn: [vm] });

    const remoteKubeconfig = new RemoteKubeconfig("vm-kubeconfig", {
        hostname: vm.vmIpAddress,
        username: args.vmConfig.sshUser,
        privKey: args.vmConfig.sshPrivKey,
        path: "/etc/rancher/k3s/k3s.yaml",
        updateServerAddress: true,
        insecure: args.insecure,
        pollDelaySeconds: 10,
    }, { ...opts, dependsOn: [waitForCloudInit] });

    return {
        vm,
        kubeconfig: remoteKubeconfig.kubeconfig,
    };
}
