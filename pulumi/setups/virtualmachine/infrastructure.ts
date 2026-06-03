import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import * as command from "@pulumi/command";
import { CloudInitProcessor, InstallRke2, RemoteKubeconfig, HarvesterCloudProvider, Leap16Repos } from "@suse-tmm/common";
import {
    BashRcLocal, cloudInit, DefaultUser, DisableIpv6, GuestAgent,
    IncreaseFileLimit, InstallK3s, KubeFirewall, NewUser, Packages,
    PackageUpdate, DhcpInterface,
} from "@suse-tmm/common";
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
}

export interface HarvesterVmInfraResult {
    vm: harvester.HarvesterVm;
}

export function provisionVmOnHarvester(
    args: HarvesterVmInfraArgs,
    opts?: pulumi.ResourceOptions,
): HarvesterVmInfraResult {
    const vmNamespace = args.vmNamespace || "harvester-public";

    let cloudInitProcessors = [NewUser({
        name: args.vmConfig.sshUser,
        password: args.vmConfig.sshPassword,
        sudo: ["ALL=(ALL) NOPASSWD:ALL"],
        sshAuthorizedKeys: [args.vmConfig.sshPubKey],
    }), GuestAgent];

    const cloudInitArgs = cloudInit(...cloudInitProcessors);

    const vm = new harvester.HarvesterVm(args.vmName, {
        kubeconfig: args.harvesterKubeconfig,
        virtualMachine: {
            namespace: vmNamespace,
            networkName: args.network.name,
            resources: {
                cpu: 2,
                memory: "4Gi",
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
            cloudInit: cloudInitArgs,
        },
    }, opts);

    return {
        vm,
    };
}
