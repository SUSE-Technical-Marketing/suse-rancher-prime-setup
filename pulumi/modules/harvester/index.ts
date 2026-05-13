// Re-export generated CRD types
export * as harvesterhci from "./generated/harvesterhci";
export * as kubevirt from "./generated/kubevirt";
export * as k8s from "./generated/k8s";
export * as network from "./generated/network";
export * as loadbalancer from "./generated/loadbalancer";

// Export base components
export { HarvesterBase, HarvesterBaseArgs } from "./src/base";
export { StorageClassArgs } from "./src/base/storageclass";
export { NetworkArgs } from "./src/base/network";
export { VmImageArgs } from "./src/base/vmimage";
export { PoolArgs } from "./src/base/ippool";
export { KeyPairArgs } from "./src/base/keypair";
export { CloudInitTemplate, CloudInitTemplateArgs } from "./src/base/cloudinittemplate";

// Export VM components
export { HarvesterVm, HarvesterVmArgs } from "./src/vm";

// Export network components
export { BridgeName, BridgeNameInputs } from "./src/network/bridge";

// Export resource components
export { HarvesterSetting, HarvesterSettingInputs } from "./src/resources/setting";
export { HarvesterAddon, HarvesterAddonInputs } from "./src/resources/addon";
