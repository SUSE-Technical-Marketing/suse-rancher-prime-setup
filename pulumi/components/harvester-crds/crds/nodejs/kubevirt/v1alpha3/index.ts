// *** WARNING: this file was generated by crd2pulumi. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

import * as pulumi from "@pulumi/pulumi";
import * as utilities from "../../utilities";

// Export members:
export { VirtualMachineArgs } from "./virtualMachine";
export type VirtualMachine = import("./virtualMachine").VirtualMachine;
export const VirtualMachine: typeof import("./virtualMachine").VirtualMachine = null as any;
utilities.lazyLoad(exports, ["VirtualMachine"], () => require("./virtualMachine"));

export { VirtualMachineInstanceArgs } from "./virtualMachineInstance";
export type VirtualMachineInstance = import("./virtualMachineInstance").VirtualMachineInstance;
export const VirtualMachineInstance: typeof import("./virtualMachineInstance").VirtualMachineInstance = null as any;
utilities.lazyLoad(exports, ["VirtualMachineInstance"], () => require("./virtualMachineInstance"));

export { VirtualMachineInstanceListArgs } from "./virtualMachineInstanceList";
export type VirtualMachineInstanceList = import("./virtualMachineInstanceList").VirtualMachineInstanceList;
export const VirtualMachineInstanceList: typeof import("./virtualMachineInstanceList").VirtualMachineInstanceList = null as any;
utilities.lazyLoad(exports, ["VirtualMachineInstanceList"], () => require("./virtualMachineInstanceList"));

export { VirtualMachineInstancePatchArgs } from "./virtualMachineInstancePatch";
export type VirtualMachineInstancePatch = import("./virtualMachineInstancePatch").VirtualMachineInstancePatch;
export const VirtualMachineInstancePatch: typeof import("./virtualMachineInstancePatch").VirtualMachineInstancePatch = null as any;
utilities.lazyLoad(exports, ["VirtualMachineInstancePatch"], () => require("./virtualMachineInstancePatch"));

export { VirtualMachineListArgs } from "./virtualMachineList";
export type VirtualMachineList = import("./virtualMachineList").VirtualMachineList;
export const VirtualMachineList: typeof import("./virtualMachineList").VirtualMachineList = null as any;
utilities.lazyLoad(exports, ["VirtualMachineList"], () => require("./virtualMachineList"));

export { VirtualMachinePatchArgs } from "./virtualMachinePatch";
export type VirtualMachinePatch = import("./virtualMachinePatch").VirtualMachinePatch;
export const VirtualMachinePatch: typeof import("./virtualMachinePatch").VirtualMachinePatch = null as any;
utilities.lazyLoad(exports, ["VirtualMachinePatch"], () => require("./virtualMachinePatch"));


const _module = {
    version: utilities.getVersion(),
    construct: (name: string, type: string, urn: string): pulumi.Resource => {
        switch (type) {
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachine":
                return new VirtualMachine(name, <any>undefined, { urn })
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachineInstance":
                return new VirtualMachineInstance(name, <any>undefined, { urn })
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachineInstanceList":
                return new VirtualMachineInstanceList(name, <any>undefined, { urn })
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachineInstancePatch":
                return new VirtualMachineInstancePatch(name, <any>undefined, { urn })
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachineList":
                return new VirtualMachineList(name, <any>undefined, { urn })
            case "kubernetes:kubevirt.io/v1alpha3:VirtualMachinePatch":
                return new VirtualMachinePatch(name, <any>undefined, { urn })
            default:
                throw new Error(`unknown resource type ${type}`);
        }
    },
};
pulumi.runtime.registerResourceModule("crds", "kubevirt.io/v1alpha3", _module)
