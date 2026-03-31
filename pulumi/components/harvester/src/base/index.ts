import * as pulumi from "@pulumi/pulumi";
import { createStorageClasses, StorageClassArgs } from "./storageclass";
import { createImages, VmImageArgs } from "./vmimage";
import { createNetworks, NetworkArgs } from "./network";
import { PoolArgs, createIpPool } from "./ippool";
import { createCloudInitTemplates, CloudInitTemplateArgs } from "./cloudinittemplate";
import { HarvesterAddon, HarvesterAddonInputs } from "../resources/addon";
import { harvesterhci } from "@suse-tmm/harvester-crds";
import { k8s as k8scrds } from "@suse-tmm/harvester-crds";
import { storage } from "@pulumi/kubernetes";

export interface HarvesterBaseArgs {
    storageClasses?: StorageClassArgs[];
    networks?: NetworkArgs[];
    images?: {
        definitions: VmImageArgs[];
        storageClassName: pulumi.Input<string>;
    };
    cloudInitTemplates?: CloudInitTemplateArgs[];
    ipPools?: PoolArgs[];
    addons?: HarvesterAddonInputs[];
}

export class HarvesterBase extends pulumi.ComponentResource {
    public storageClasses: Record<string, storage.v1.StorageClass>;
    public images: Record<string, harvesterhci.v1beta1.VirtualMachineImage>;
    public networks: Record<string, k8scrds.v1.NetworkAttachmentDefinition>;
    public addons: Record<string, HarvesterAddon>;

    constructor(name: string, args: HarvesterBaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:base", name, {}, opts);

        const myOpts = { ...opts, parent: this };
        this.addons = {};
        for (const addon of args.addons ?? []) {
            this.addons[addon.addonName] = new HarvesterAddon(addon.addonName, addon, myOpts);
        }

        this.storageClasses = createStorageClasses(args.storageClasses ?? [], myOpts);
        this.networks = createNetworks(args.networks ?? [], myOpts);

        if (args.cloudInitTemplates) {
            createCloudInitTemplates(args.cloudInitTemplates, myOpts);
        }

        const storageDeps = Object.values(this.storageClasses);
        this.images = args.images
            ? createImages(args.images.definitions, args.images.storageClassName, { ...myOpts, dependsOn: storageDeps })
            : {};

        for (const pool of args.ipPools ?? []) {
            createIpPool(pool.name, pool, {...myOpts, dependsOn: [...Object.values(this.networks), ...Object.values(this.addons)]});
        }

        this.registerOutputs({
            storageClasses: this.storageClasses,
            images: this.images,
            networks: this.networks,
            addons: this.addons,
        });
    }
}
