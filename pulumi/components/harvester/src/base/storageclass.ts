import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface StorageClassArgs {
    name: string;
    provisioner: string;
    parameters?: Record<string, string>;
    volumeBindingMode?: string;
    reclaimPolicy?: string;
    allowVolumeExpansion?: boolean;
}

export function createStorageClasses(storageClasses: StorageClassArgs[], opts: pulumi.CustomResourceOptions): Record<string, k8s.storage.v1.StorageClass> {
    const result: Record<string, k8s.storage.v1.StorageClass> = {};
    for (const sc of storageClasses) {
        result[sc.name] = new k8s.storage.v1.StorageClass(sc.name, {
            metadata: { name: sc.name },
            provisioner: sc.provisioner,
            parameters: sc.parameters,
            volumeBindingMode: sc.volumeBindingMode ?? "Immediate",
            reclaimPolicy: sc.reclaimPolicy ?? "Delete",
            allowVolumeExpansion: sc.allowVolumeExpansion ?? true,
        }, opts);
    }
    return result;
}
