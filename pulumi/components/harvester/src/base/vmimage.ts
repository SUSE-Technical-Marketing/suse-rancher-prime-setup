import * as pulumi from "@pulumi/pulumi";
import * as harvester from "../../crds/nodejs/harvesterhci/v1beta1";

export interface VmImageArgs {
    name: string;
    displayName: string;
    url: string;
    sourceType?: string;
}

const DefaultImages: VmImageArgs[] = [
    {
        name: "opensuse-leap-15.6",
        displayName: "openSUSE Leap 15.6",
        url: "https://download.opensuse.org/repositories/Cloud:/Images:/Leap_15.6/images/openSUSE-Leap-15.6.x86_64-NoCloud.qcow2",
    },
    {
        name: "centos-stream-10",
        displayName: "CentOS Stream 10",
        url: "https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-20250512.0.x86_64.qcow2",
    },
    {
        name: "ubuntu-24.04",
        displayName: "Ubuntu 24.04 LTS",
        url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
    }
];

function addImage(name: string, image: any, opts: pulumi.CustomResourceOptions) {
    return new harvester.VirtualMachineImage(name, {
        metadata: {
            name: name,
            namespace: "harvester-public",
            annotations: {
                "pulumi.com/waitFor": "condition=Imported",
                "harvesterhci.io/storageClassName": "longhorn-single",
            }
        },
        spec: {
            displayName: image.displayName,
            url: image.url,
            sourceType: image.sourceType || "download",
        }
    }, opts);
}

export function createImages(extraImages: VmImageArgs[], opts: pulumi.CustomResourceOptions): Map<string, harvester.VirtualMachineImage> {
    const images = new Map<string, harvester.VirtualMachineImage>();
    (DefaultImages.concat(extraImages)).forEach((image) => {
        images.set(image.name, addImage(image.name, image, opts));
    });

    return images;
}
