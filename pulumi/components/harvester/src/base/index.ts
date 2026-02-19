import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {createSingleReplicaStorageClass} from "./storageclass";
import { createImages, VmImageArgs } from "./vmimage";
import { createNetworks } from "./network";
import { createCloudInitTemplates } from "./cloudinittemplate";
import { harvesterhci } from "@suse-tmm/harvester-crds";
import { k8s as k8scrds } from "@suse-tmm/harvester-crds";
import { storage } from "@pulumi/kubernetes";

export interface HarvesterBaseArgs {
    extraImages?: VmImageArgs[];
    clusterNetwork?: string;
    sshUser: string;
    sshPublicKey: string;
}

export class HarvesterBase extends pulumi.ComponentResource {
    public images: Map<string, harvesterhci.v1beta1.VirtualMachineImage>;
    public networks: Map<string, k8scrds.v1.NetworkAttachmentDefinition>;
    public storageClass: storage.v1.StorageClass;

    constructor(name: string, args: HarvesterBaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:base", name, {}, opts);

        const myOpts = { ...opts, parent: this };
        this.storageClass = createSingleReplicaStorageClass(myOpts);
        this.networks = createNetworks(args.clusterNetwork || "mgmt", myOpts);
        createCloudInitTemplates(args.sshUser, args.sshPublicKey, myOpts);
        this.images = createImages(args.extraImages || [], this.storageClass.metadata.name, { ...myOpts, dependsOn: [this.storageClass] });

        this.registerOutputs({
            images: this.images,
            storageClass: this.storageClass,
            networks: this.networks,
        });
    }
};
