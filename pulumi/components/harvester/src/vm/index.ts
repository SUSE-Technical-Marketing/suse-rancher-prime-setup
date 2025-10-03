import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createVirtualMachine, VirtualMachineArgs } from "./virtualmachine"
import { VmIpAddress } from "./ipaddress";

export interface HarvesterVmArgs {
    kubeconfig: pulumi.Input<string>;
    virtualMachine: VirtualMachineArgs;
}

export class HarvesterVm extends pulumi.ComponentResource {
    public vmIpAddress: pulumi.Output<string>;

    constructor(name: string, args: HarvesterVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:virtualmachine", name, {}, opts);

        const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });

        const vm = createVirtualMachine(name, args.virtualMachine, {
                provider: harvesterK8sProvider,
                parent: this,
        });

        this.vmIpAddress = new VmIpAddress(`${name}-ip`, {
            kubeconfig: args.kubeconfig,
            namespace: vm.metadata.namespace,
            name: vm.metadata.name,
            networkName: args.virtualMachine.network.name,
            timeout: 60, // Wait up to 60 seconds for the IP address to be available
        }, {
            parent: this,
        }).ipAddress;

        this.registerOutputs({
            vmIpAddress: this.vmIpAddress,
        });
;
    }
};

