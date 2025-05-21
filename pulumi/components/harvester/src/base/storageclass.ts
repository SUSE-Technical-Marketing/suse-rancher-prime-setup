import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export function createSingleReplicaStorageClass(opts: pulumi.CustomResourceOptions) {
    return new k8s.storage.v1.StorageClass("longhorn-single", {
        metadata: {
            name: "longhorn-single",
        },
        provisioner: "driver.longhorn.io",
        parameters: {
            "numberOfReplicas": "1",
            "migratable": "true",
            "staleReplicaTimeout": "30",
        },
        volumeBindingMode: "Immediate",
        reclaimPolicy: "Delete",
        allowVolumeExpansion: true
    }, opts);
}
