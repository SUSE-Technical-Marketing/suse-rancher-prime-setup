import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {createSingleReplicaStorageClass} from "./storageclass";
import { createImages, VmImageArgs } from "./vmimage";
import { createNetworks } from "./network";
import { fileSync } from "tmp";
import { writeFileSync } from "fs";
import { harvesterhci } from "@suse-tmm/harvester-crds";
import { k8s as k8scrds } from "@suse-tmm/harvester-crds";
import { StorageClass } from "@pulumi/kubernetes/storage/v1";

export interface HarvesterBaseArgs {
    kubeconfig: pulumi.Input<string>;
    extraImages?: pulumi.Input<VmImageArgs[]>;
}

export class HarvesterBase extends pulumi.ComponentResource {
    public images: pulumi.Output<Map<string, harvesterhci.v1beta1.VirtualMachineImage>>;
    public networks: Map<string, k8scrds.v1.NetworkAttachmentDefinition>;
    public storageClass: StorageClass;
    constructor(name: string, args: HarvesterBaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:base", name, {}, opts);

        const harvesterK8sProvider = new k8s.Provider("harvester-k8s", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });
        this.storageClass = createSingleReplicaStorageClass({ provider: harvesterK8sProvider, parent: this });
        this.networks = createNetworks({ provider: harvesterK8sProvider, parent: this });

        const out = pulumi.all([args.kubeconfig, args.extraImages]).apply(([kubeconfig, extraImages]) => {
            const images = createImages(extraImages || [], { provider: harvesterK8sProvider, dependsOn: [this.storageClass], parent: this });

            return { images };
        });
        this.images = out.images;
        this.registerOutputs({
            images: this.images,
            storageClass: this.storageClass,
            networks: this.networks,
        });
    }
};

