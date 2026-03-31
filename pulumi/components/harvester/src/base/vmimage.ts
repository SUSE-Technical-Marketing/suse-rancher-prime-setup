import * as pulumi from "@pulumi/pulumi";
import {harvesterhci} from "@suse-tmm/harvester-crds";

export interface VmImageArgs {
    name: string;
    namespace?: string;
    displayName: string;
    url: string;
    sourceType?: string;
}

export function createImages(images: VmImageArgs[], storageClassName: pulumi.Input<string>, opts: pulumi.CustomResourceOptions): Record<string, harvesterhci.v1beta1.VirtualMachineImage> {
    const result: Record<string, harvesterhci.v1beta1.VirtualMachineImage> = {};
    for (const image of images) {
        result[image.name] = new harvesterhci.v1beta1.VirtualMachineImage(image.name, {
            metadata: {
                name: image.name,
                namespace: image.namespace ?? "harvester-public",
                annotations: {
                    "pulumi.com/waitFor": "condition=Imported",
                    "harvesterhci.io/storageClassName": storageClassName,
                },
            },
            spec: {
                displayName: image.displayName,
                url: image.url,
                sourceType: image.sourceType ?? "download",
            },
        }, opts);
    }
    return result;
}
