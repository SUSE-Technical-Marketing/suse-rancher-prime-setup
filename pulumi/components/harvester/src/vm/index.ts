import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { CloudInitArgs } from "@suse-tmm/utils";
import { fileSync } from "tmp";
import { writeFileSync } from "fs";
import { createVirtualMachine, VirtualMachineArgs } from "./virtualmachine"
import { VirtualMachine } from "../../crds/nodejs/kubevirt/v1/virtualMachine";

export interface HarvesterVmArgs {
    kubeconfig: pulumi.Input<string>;
    virtualMachine: pulumi.Input<VirtualMachineArgs>;
}

export class HarvesterVm extends pulumi.ComponentResource {

    constructor(name: string, args: HarvesterVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:virtualmachine", name, {}, opts);

        pulumi.all([args.kubeconfig, args.virtualMachine]).apply(async ([kubeconfig, virtualMachine]) => {
            const kubeconfigFile = fileSync({ prefix: "kubeconfig", postfix: ".yaml" });
            const fn = kubeconfigFile.name
            writeFileSync(fn, kubeconfig);

            const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
                kubeconfig: fn,
            }, { parent: this });

            return createVirtualMachine(name, virtualMachine, {
                provider: harvesterK8sProvider,
                parent: this,
            });
        });
    }
};

