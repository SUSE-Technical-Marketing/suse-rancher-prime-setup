import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { fileSync } from "tmp";
import { writeFileSync } from "fs";
import { createVirtualMachine, VirtualMachineArgs } from "./virtualmachine"
import { kubevirt } from "@suse-tmm/harvester-crds";
import { VmIpAddress } from "./ipaddress";

export interface HarvesterVmArgs {
    kubeconfig: pulumi.Input<string>;
    virtualMachine: pulumi.Input<VirtualMachineArgs>;
}

export class HarvesterVm extends pulumi.ComponentResource {
    public vmIpAddress: pulumi.Output<string>;

    constructor(name: string, args: HarvesterVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:virtualmachine", name, {}, opts);

        const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });

        const vmiOutput = pulumi.all([args.virtualMachine]).apply(async ([virtualMachine]) => {
            const vm = createVirtualMachine(name, virtualMachine, {
                provider: harvesterK8sProvider,
                parent: this,
            });

            return vm;
        });

        this.vmIpAddress = new VmIpAddress(`${name}-ip`, {
            kubeconfig: args.kubeconfig,
            namespace: vmiOutput.metadata.namespace,
            name: vmiOutput.metadata.name,
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

