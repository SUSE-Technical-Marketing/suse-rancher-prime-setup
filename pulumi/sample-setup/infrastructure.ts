import * as pulumi from "@pulumi/pulumi";
import * as harvester from "@suse-tmm/harvester";
import * as command from "@pulumi/command";
import { CloudInitProcessor, InstallRke2, RemoteKubeconfig, HarvesterCloudProvider } from "@suse-tmm/utils";
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
    k3sVersion?: string;
    rke2Version?: string;
    insecure: boolean;
}

export interface HarvesterVmInfraResult {
    vm: harvester.HarvesterVm;
    kubeconfig: pulumi.Output<string>;
}

export function provisionVmOnHarvester(
    args: HarvesterVmInfraArgs,
    opts?: pulumi.ResourceOptions,
): HarvesterVmInfraResult {
    let kubeProcessor: CloudInitProcessor;
    if (args.k3sVersion) {
        kubeProcessor = InstallK3s(false, args.k3sVersion);
    } else if (args.rke2Version) {
        kubeProcessor = InstallRke2(false, args.rke2Version, true);
    } else {
        throw new Error("Either k3sVersion or rke2Version must be provided");
    }

    const vmNamespace = args.vmNamespace || "harvester-public";

    const buildCloudInit = (harvesterKc?: string) => cloudInit(
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
        kubeProcessor,
        // ...(harvesterKc ? [HarvesterCloudProvider(harvesterKc, vmNamespace)] : []),
    );

    // If using RKE2, we need the kubeconfig resolved for HarvesterCloudProvider
    const cloudInitArgs = args.rke2Version
        ? pulumi.output(args.harvesterKubeconfig).apply(kc => buildCloudInit(kc))
        : buildCloudInit();

    const vm = new harvester.HarvesterVm(args.vmName, {
        kubeconfig: args.harvesterKubeconfig,
        virtualMachine: {
            namespace: vmNamespace,
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
            cloudInit: cloudInitArgs,
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
