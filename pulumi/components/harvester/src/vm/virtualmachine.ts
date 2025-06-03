import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { harvesterhci } from "@suse-tmm/harvester-crds";
import { kubevirt } from "@suse-tmm/harvester-crds";
import { CloudInitArgs, renderCloudInit } from "@suse-tmm/utils";
import { Secret } from "@pulumi/kubernetes/core/v1";

const volumeClaimTemplatesAnnotation = "harvesterhci.io/volumeClaimTemplates";

export interface ResourcesArgs {
    cpu: pulumi.Input<number>;
    // Memory using `xGi` or `xMi` format
    memory: pulumi.Input<string>;
}

export interface NetworkArgs {
    name: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
}

export interface DiskArgs {
    name: pulumi.Input<string>;
    size: pulumi.Input<string>;
    image: harvesterhci.v1beta1.VirtualMachineImage;
}

export interface VirtualMachineArgs {
    namespace: pulumi.Input<string>;
    resources: ResourcesArgs;
    cloudInit?: CloudInitArgs;
    network: NetworkArgs;
    disk: DiskArgs;
}

export function createVirtualMachine(name: string, args: VirtualMachineArgs, opts: pulumi.ComponentResourceOptions) {
    let volumes = [];
    const pvc = pulumi.output(createPvc(name, args.namespace, args.disk, opts));

    volumes.push({
        name: "disk0",
        persistentVolumeClaim: {
            claimName: pvc.metadata.name,
        },
    });
    let disks = []
    disks.push({
        name: "disk0",
        disk: {
            bus: "virtio",
        },
        bootOrder: 1,
    });

    if (args.cloudInit) {
        const cloudinitSecret = createCloudInitSecret(name, args.namespace, args.cloudInit, opts);
        volumes.push({
            name: "cloudinitdisk",
            cloudInitNoCloud: {
                secretRef: {
                    name: cloudinitSecret.metadata.name
                },
                networkDataSecretRef: {
                    name: cloudinitSecret.metadata.name
                }
            },
        });
        disks.push({
            name: "cloudinitdisk",
            disk: {
                bus: "virtio",
            },
        });
    }

    const vm = new kubevirt.v1.VirtualMachine(name, {
        metadata: {
            name: name,
            namespace: args.namespace,
            annotations: {
                "pulumi.com/waitFor": "condition=AgentConnected"
            }
        },
        spec: {
            runStrategy: "RerunOnFailure",
            template: {
                metadata: {
                    labels: {
                        "harvesterhci.io/vmName": name,
                    },
                },
                spec: {
                    domain: {
                        cpu: {
                            cores: args.resources.cpu,
                            sockets: 1,
                            threads: 1,
                        },
                        devices: {
                            interfaces: [
                                {
                                    name: args.network.name,
                                    model: "virtio",
                                    bridge: {}
                                }
                            ],
                            inputs: [
                                {
                                    bus: "usb",
                                    name: "tablet",
                                    type: "tablet",
                                }
                            ],
                            disks: disks,
                        },
                        features: {
                            acpi: {
                                enabled: true
                            }
                        },
                        resources: {
                            limits: {
                                cpu: `${args.resources.cpu}`,
                                memory: args.resources.memory,
                            },
                        },
                    },
                    evictionStrategy: "LiveMigrateIfPossible",
                    hostname: name,
                    networks: [
                        {
                            name: args.network.name,
                            multus: {
                                networkName: pulumi.interpolate`${args.network.namespace}/${args.network.name}`
                            }
                        }
                    ],
                    volumes: volumes,
                }
            }
        }
    }, opts);

    return vm;
}

function createPvc(name: string, namespace: pulumi.Input<string>, disk: DiskArgs, opts: pulumi.ComponentResourceOptions): k8s.core.v1.PersistentVolumeClaim {
    return new k8s.core.v1.PersistentVolumeClaim(`${name}-${disk.name}`, {
        metadata: {
            name: `${name}-${disk.name}`,
            namespace: namespace,
            annotations: {
                "harvesterhci.io/imageId": disk.image.id
            },
            labels: {
                "harvesterhci.io/creator": "pulumi",
                "harvesterhci.io/vmName": name
            }
        },
        spec: {
            accessModes: ["ReadWriteMany"],
            resources: {
                requests: {
                    storage: disk.size,
                }
            },
            volumeMode: "Block",
            storageClassName: disk.image.status.storageClassName,
        }
    }, { ...opts, dependsOn: [disk.image] })
};

function createCloudInitSecret(name: string, namespace: pulumi.Input<string>, cloudInit: CloudInitArgs, opts: pulumi.ComponentResourceOptions): Secret {
    const cloudInitContents = renderCloudInit(cloudInit);
    const cloudInitSecret = new Secret(`${name}-cloudinit`, {
        metadata: {
            name: `${name}-cloudinit`,
            namespace: namespace,
            labels: {
                "harvesterhci.io/cloud-init-template": "harvester",
                "harvesterhci.io/creator": "pulumi",
                "harvesterhci.io/vmName": name
            }
        },
        stringData: {
            "userdata": cloudInitContents,
            "networkdata": ""
        },
        type: "secret"
    }, opts);
    return cloudInitSecret;
}
