import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { fileSync } from "tmp";
import { writeFileSync } from "fs";
import { createVirtualMachine, VirtualMachineArgs } from "./virtualmachine"
import { kubevirt } from "@suse-tmm/harvester-crds";

export interface HarvesterVmArgs {
    kubeconfig: pulumi.Input<string>;
    virtualMachine: pulumi.Input<VirtualMachineArgs>;
}

export class HarvesterVm extends pulumi.ComponentResource {
    public virtualMachineInstance: pulumi.Output<kubevirt.v1.VirtualMachineInstance>;

    constructor(name: string, args: HarvesterVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:virtualmachine", name, {}, opts);

        const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });

        const vmiOutput = pulumi.all([args.kubeconfig, args.virtualMachine]).apply(async ([kubeconfig, virtualMachine]) => {
            const vm = createVirtualMachine(name, virtualMachine, {
                provider: harvesterK8sProvider,
                parent: this,
            });

            return vm;
        });

        this.virtualMachineInstance = vmiOutput.apply((vm) => {
            const vmi = kubevirt.v1.VirtualMachineInstance.get(name, pulumi.interpolate`${vm.metadata.namespace}/${vm.metadata.name}`, {
                provider: harvesterK8sProvider,
                parent: this,
                dependsOn: [vm],
            });
            return vmi;
        });
        this.registerOutputs({
            virtualMachineInstance: this.virtualMachineInstance,
        });
;
    }
};

