import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { kubevirt } from "@lab/crds";
import { HarvesterImage } from "./base";
import { KubeValue } from "./kube-value";

export interface HarvesterVmArgs {
    /** The Harvester's name, which is also its kubeconfig context. */
    harvester: string;
    namespace: pulumi.Input<string>;
    /** VM name on Harvester; the DNS controller registers it as `<name>.<domain>`. */
    vmName: string;
    cpu: number;
    memory: string;
    disk: string;
    image: HarvesterImage;
    /** `namespace/name` of the network attachment. */
    network: pulumi.Input<string>;
    macAddress?: string;
    /** `#cloud-config` user data; secret because it may hold registration codes. */
    userData: pulumi.Input<string>;
    /** `namespace/name` of the Harvester key pair, shown in the Harvester UI. */
    keyPair?: pulumi.Input<string>;
}

/**
 * A Harvester VM with one root disk cloned from an OS image. The disk is a separate PVC so it
 * is deleted with the VM; `ipAddress` comes from the guest agent once the VM is up.
 */
export class HarvesterVm extends pulumi.ComponentResource {
    readonly vm: kubevirt.v1.VirtualMachine;
    readonly ipAddress: pulumi.Output<string>;

    constructor(name: string, args: HarvesterVmArgs, opts: pulumi.ComponentResourceOptions & { provider: k8s.Provider }) {
        super("lab:harvester:Vm", name, {}, opts);
        const child = (suffix: string) => `${name}/${suffix}`;
        const o: pulumi.CustomResourceOptions = { parent: this, provider: opts.provider };
        const labels = { "harvesterhci.io/vmName": args.vmName, "app.kubernetes.io/managed-by": "lab" };

        const cloudInit = new k8s.core.v1.Secret(child("cloudinit"), {
            metadata: { name: `${args.vmName}-cloudinit`, namespace: args.namespace, labels },
            stringData: { userdata: pulumi.secret(args.userData) },
        }, {
            ...o,
            // Same name, so the old one must go first. A running VM doesn't notice: cloud-init
            // only reads it on first boot.
            deleteBeforeReplace: true,
        });

        const disk = new k8s.core.v1.PersistentVolumeClaim(child("disk"), {
            metadata: {
                name: `${args.vmName}-disk-0`,
                namespace: args.namespace,
                labels,
                annotations: { "harvesterhci.io/imageId": args.image.id },
            },
            spec: {
                accessModes: ["ReadWriteMany"],
                volumeMode: "Block",
                storageClassName: args.image.storageClassName,
                resources: { requests: { storage: args.disk } },
            },
        }, o);

        this.vm = new kubevirt.v1.VirtualMachine(child("vm"), {
            metadata: {
                name: args.vmName,
                namespace: args.namespace,
                labels,
                annotations: {
                    // Wait for the guest agent: it reports the IP address, which DNS depends on.
                    "pulumi.com/waitFor": "condition=AgentConnected",
                    "pulumi.com/timeoutSeconds": "1800",
                    ...(args.keyPair ? { "harvesterhci.io/sshNames": pulumi.output(args.keyPair).apply(k => JSON.stringify([k])) } : {}),
                },
            },
            spec: {
                runStrategy: "RerunOnFailure",
                template: {
                    metadata: { labels },
                    spec: {
                        hostname: args.vmName,
                        evictionStrategy: "LiveMigrateIfPossible",
                        domain: {
                            cpu: { cores: args.cpu, sockets: 1, threads: 1 },
                            memory: { guest: args.memory },
                            resources: { limits: { cpu: String(args.cpu), memory: args.memory } },
                            features: { acpi: { enabled: true } },
                            devices: {
                                disks: [
                                    { name: "disk-0", disk: { bus: "virtio" }, bootOrder: 1 },
                                    { name: "cloudinit", disk: { bus: "virtio" } },
                                ],
                                interfaces: [{ name: "default", model: "virtio", bridge: {}, macAddress: args.macAddress }],
                            },
                        },
                        networks: [{ name: "default", multus: { networkName: args.network } }],
                        volumes: [
                            { name: "disk-0", persistentVolumeClaim: { claimName: disk.metadata.name } },
                            { name: "cloudinit", cloudInitNoCloud: { secretRef: { name: cloudInit.metadata.name } } },
                        ],
                    },
                },
            },
        }, { ...o, dependsOn: [disk, cloudInit] });

        this.ipAddress = new KubeValue(child("ip"), {
            target: { context: args.harvester },
            path: pulumi.interpolate`/apis/kubevirt.io/v1/namespaces/${args.namespace}/virtualmachineinstances/${args.vmName}`,
            field: "status.interfaces.0.ipAddress",
            timeoutSeconds: 600,
        }, { parent: this, dependsOn: [this.vm] }).value;

        this.registerOutputs({ ipAddress: this.ipAddress });
    }
}
