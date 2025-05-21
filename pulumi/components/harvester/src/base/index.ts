import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {createSingleReplicaStorageClass} from "./storageclass";
import { createImages, VmImageArgs } from "./vmimage";
import { createNetworks } from "./network";
import { fileSync } from "tmp";
import { writeFileSync } from "fs";
import { VirtualMachineImage } from "../../crds/nodejs/harvesterhci/v1beta1";
import { NetworkAttachmentDefinition } from "../../crds/nodejs/k8s/v1";
import { StorageClass } from "@pulumi/kubernetes/storage/v1";

export interface HarvesterBaseArgs {
    kubeconfig: pulumi.Input<string>;
    extraImages?: pulumi.Input<VmImageArgs[]>;
}

export class HarvesterBase extends pulumi.ComponentResource {
    public images: pulumi.Output<Map<string, VirtualMachineImage>>;
    public networks: pulumi.Output<Map<string, NetworkAttachmentDefinition>>;
    public storageClass: pulumi.Output<StorageClass>;
    constructor(name: string, args: HarvesterBaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:base", name, {}, opts);

        const out = pulumi.all([args.kubeconfig, args.extraImages]).apply(async ([kubeconfig, extraImages]) => {
            const kubeconfigFile = fileSync({ prefix: "kubeconfig", postfix: ".yaml" });
            const fn = kubeconfigFile.name
            writeFileSync(fn, kubeconfig);

            const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
                kubeconfig: fn,
            }, { parent: this });

            const storageClass = pulumi.output(createSingleReplicaStorageClass({ provider: harvesterK8sProvider, parent: this }));
            const images = createImages(extraImages || [], { provider: harvesterK8sProvider, dependsOn: [storageClass], parent: this });
            const networks = createNetworks({ provider: harvesterK8sProvider, parent: this });

            return { storageClass, images, networks };
        });
        this.images = out.images;
        this.storageClass = out.storageClass;
        this.networks = out.networks;
        this.registerOutputs({
            images: this.images,
            storageClass: this.storageClass,
            networks: this.networks,
        });
    }
};

