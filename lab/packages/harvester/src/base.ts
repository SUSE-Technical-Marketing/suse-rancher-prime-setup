import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { harvesterhci, k8s as cni, loadbalancer, network } from "@lab/crds";
import type { ResolvedHarvester, Timeouts } from "@lab/schema";
import { HarvesterAddon } from "./addon";
import { DefaultStorageClassReset } from "./default-class";
import { LoadBalancerCleanup } from "./lb-cleanup";
import { NamespaceBindingsCleanup } from "./rbac-cleanup";

export interface HarvesterBaseArgs {
    harvester: ResolvedHarvester;
    /** Namespace on the Harvester that holds everything the lab creates there. */
    namespace: string;
    domain: string;
    /** The lab's login and key; a lab without hosts has none, and gets no key pair. */
    ssh?: { user: string; publicKey: string };
    /** Networks hosts or downstream pools use; only these (and networks with DHCP) are created. */
    usedNetworks: string[];
    /** Catalog charts at their versions (DESIGN.md §16.2). */
    charts: { dhcpController: Chart };
    timeouts: Pick<Timeouts, "harvesterAddon" | "image" | "loadBalancerCleanup">;
}

/** A catalog chart at a version: `repo` unless it's an `oci://` chart. */
export interface Chart {
    chart: string;
    repo?: string;
    version: string;
}

export interface HarvesterImage {
    /** `namespace/name`, as used in `harvesterhci.io/imageId`. */
    id: pulumi.Output<string>;
    storageClassName: pulumi.Output<string>;
}

const WAIT = "pulumi.com/waitFor";
const TIMEOUT = "pulumi.com/timeoutSeconds";

/**
 * Everything a lab needs on one Harvester before VMs can be created: its namespace, storage
 * class, VM networks with DHCP, the SSH key pair and the OS images. The Harvester's own profiles
 * (the DNS controller) add their resources as its children and to `ready`. Nothing here is
 * retained on delete: a destroyed lab leaves the Harvester as it found it.
 */
export class HarvesterBase extends pulumi.ComponentResource {
    readonly namespace: k8s.core.v1.Namespace;
    /** Network name (`untagged`, `vlan20`) -> `namespace/name` for VM interfaces. */
    readonly networks: Record<string, pulumi.Output<string>> = {};
    /** OS name -> image. */
    readonly images: Record<string, HarvesterImage> = {};
    /** What a VM on this Harvester has to wait for (networks, DHCP pools, the Harvester's profiles). */
    readonly ready: pulumi.Resource[] = [];

    constructor(name: string, args: HarvesterBaseArgs, opts: pulumi.ComponentResourceOptions & { provider: k8s.Provider }) {
        super("lab:harvester:Base", name, {}, opts);
        const h = args.harvester;
        const child = (suffix: string) => `${name}/${suffix}`;
        const o: pulumi.CustomResourceOptions = { parent: this, provider: opts.provider };

        // Created first so that it's deleted after the namespace.
        const bindings = new NamespaceBindingsCleanup(child("rbac-cleanup"), { harvester: h.name, namespace: args.namespace }, { parent: this });
        this.namespace = new k8s.core.v1.Namespace(child("namespace"), {
            metadata: { name: args.namespace, labels: { "app.kubernetes.io/managed-by": "lab" } },
        }, { ...o, dependsOn: [bindings] });
        const ns = this.namespace.metadata.name;
        const inNs: pulumi.CustomResourceOptions = { ...o, dependsOn: [this.namespace] };

        // Harvester's own class is the default, and its webhook refuses a second one: reset it first
        // (and give it back on delete, after the lab's class is gone).
        const resetDefault = new DefaultStorageClassReset(child("default-class-reset"), { harvester: h.name, className: h.storageClass.name }, { parent: this });
        const storageClass = new k8s.storage.v1.StorageClass(child("storageclass"), {
            // The Harvester's default class from the moment it exists, so every PVC without a class lands here.
            metadata: { name: h.storageClass.name, annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
            provisioner: "driver.longhorn.io",
            allowVolumeExpansion: true,
            reclaimPolicy: "Delete",
            volumeBindingMode: "Immediate",
            parameters: { ...h.storageClass.parameters, numberOfReplicas: String(h.storageClass.replicas) },
        }, { ...o, dependsOn: [resetDefault] });

        // --- Networks and DHCP ---------------------------------------------------------------
        const networks = h.networks.filter(n => args.usedNetworks.includes(n.name) || n.dhcp || n.loadBalancer);
        const dhcpNeeded = networks.some(n => n.dhcp);
        const dhcpAddon = dhcpNeeded ? new HarvesterAddon(child("dhcp-controller"), {
            harvester: h.name,
            name: "harvester-vm-dhcp-controller",
            namespace: "harvester-system",
            labels: { "addon.harvesterhci.io/experimental": "true" },
            // Harvester add-ons install from a Helm repository, not an OCI reference.
            repo: args.charts.dhcpController.repo ?? (() => { throw new Error("catalog.components.harvester-vm-dhcp-controller needs a repo: Harvester add-ons can't use oci:// charts"); })(),
            chart: args.charts.dhcpController.chart,
            version: args.charts.dhcpController.version,
            timeoutSeconds: args.timeouts.harvesterAddon,
            // One per Harvester: one already there (another setup's) is used as it is.
            shared: true,
        }, { parent: this }) : undefined;

        const nads: Record<string, pulumi.Resource> = {};
        for (const net of networks) {
            const untagged = net.vlanId === undefined;
            const nad = new cni.v1.NetworkAttachmentDefinition(child(`network/${net.name}`), {
                metadata: {
                    name: net.name,
                    namespace: ns,
                    annotations: {
                        "network.harvesterhci.io/clusternetwork": h.clusterNetwork,
                        "network.harvesterhci.io/ready": "true",
                        "network.harvesterhci.io/type": untagged ? "UntaggedNetwork" : "L2VlanNetwork",
                    },
                },
                spec: {
                    config: JSON.stringify({
                        cniVersion: "0.3.1",
                        name: net.name,
                        type: "bridge",
                        bridge: `${h.clusterNetwork}-br`,
                        promiscMode: true,
                        ...(untagged ? {} : { vlan: net.vlanId }),
                        ipam: {},
                    }),
                },
            }, inNs);
            this.networks[net.name] = pulumi.interpolate`${ns}/${net.name}`;
            nads[net.name] = nad;
            this.ready.push(nad);

            if (net.dhcp && dhcpAddon) {
                const exclude = [net.dhcp.gateway, ...(net.dhcp.dns ?? [net.dhcp.gateway])];
                this.ready.push(new network.v1alpha1.IPPool(child(`ippool/${net.name}`), {
                    metadata: { name: net.name, namespace: ns },
                    spec: {
                        networkName: pulumi.interpolate`${ns}/${net.name}`,
                        ipv4Config: {
                            serverIP: net.dhcp.server,
                            cidr: net.dhcp.cidr,
                            pool: { start: net.dhcp.range[0], end: net.dhcp.range[1], exclude: [...new Set(exclude)] },
                            router: net.dhcp.gateway,
                            dns: net.dhcp.dns ?? [net.dhcp.gateway],
                            domainName: args.domain,
                            domainSearch: [args.domain],
                            leaseTime: 3600,
                        },
                    },
                }, { ...inNs, dependsOn: [nad, dhcpAddon] }));
            }
        }

        // --- Load-balancer pools for guest clusters ---------------------------------------------
        const pools: pulumi.Resource[] = [];
        for (const net of networks.filter(n => n.loadBalancer)) {
            const pool = net.loadBalancer!;
            pools.push(new loadbalancer.v1beta1.IPPool(child(`lb-pool/${net.name}`), {
                // Cluster-scoped: prefixed with the lab's namespace to stay unique on the Harvester.
                metadata: { name: pulumi.interpolate`${ns}-${net.name}` },
                spec: {
                    description: pulumi.interpolate`Load balancers of lab ${ns} on ${net.name}`,
                    ranges: [{ subnet: pool.cidr, gateway: pool.gateway, rangeStart: pool.range[0], rangeEnd: pool.range[1] }],
                    // No `network` here: guest-cluster cloud providers ask for a pool by namespace
                    // and cluster only, and a pool naming a network never matches such a request.
                    // The range is on this network; kube-vip announces it from the guest VMs.
                    selector: {
                        scope: [{ project: "*", namespace: ns, guestCluster: "*" }],
                    },
                },
            }, { ...o, dependsOn: [this.namespace, nads[net.name]] })); // Harvester checks the network exists
        }
        if (pools.length > 0) {
            // VMs wait for this instead of the pools, so on destroy it removes the guests' load
            // balancers after the VMs are gone and before the pools are deleted.
            this.ready.push(new LoadBalancerCleanup(child("lb-cleanup"), { harvester: h.name, namespace: ns, timeoutSeconds: args.timeouts.loadBalancerCleanup }, { parent: this, dependsOn: pools }));
        }

        // --- SSH key pair and images --------------------------------------------------------------
        if (args.ssh) {
            new harvesterhci.v1beta1.KeyPair(child("keypair"), {
                metadata: { name: args.ssh.user, namespace: ns },
                spec: { publicKey: args.ssh.publicKey },
            }, inNs);
        }

        for (const image of h.images) {
            if (image.source.kind === "file") {
                throw new Error(`harvester ${h.name}: uploading local image files (${image.os}) is not implemented yet; use a url for now`);
            }
            const vmImage = new harvesterhci.v1beta1.VirtualMachineImage(child(`image/${image.os}`), {
                metadata: {
                    name: image.os,
                    namespace: ns,
                    annotations: {
                        [WAIT]: "condition=Imported",
                        [TIMEOUT]: String(args.timeouts.image),
                        // The create webhook reads this before targetStorageClassName, otherwise
                        // it derives the per-image class's parameters from the cluster default.
                        "harvesterhci.io/storageClassName": h.storageClass.imageClass,
                    },
                },
                spec: {
                    displayName: image.os,
                    sourceType: "download",
                    url: image.source.url,
                    // Image data goes here; VM disks use Harvester's generated per-image class.
                    targetStorageClassName: h.storageClass.imageClass,
                    // Initial parameters; the webhook replaces these with the annotated class's.
                    storageClassParameters: { ...h.storageClass.parameters, numberOfReplicas: String(h.storageClass.replicas) },
                },
            }, {
                ...inNs,
                // The lab's own class has to exist before an image can be stored in it.
                dependsOn: [this.namespace, ...(h.storageClass.imageClass === h.storageClass.name ? [storageClass] : [])],
                // Harvester fills in its own storageClassParameters and rejects any change to them.
                ignoreChanges: ["spec.storageClassParameters"],
                // A different image, or another class, means a new image.
                replaceOnChanges: ["spec.url", "spec.sourceType", "spec.targetStorageClassName"],
                deleteBeforeReplace: true,
            });
            this.images[image.os] = {
                // Downstream pools also need to wait for the image to finish importing.
                id: vmImage.metadata.apply(m => `${m.namespace}/${m.name}`),
                storageClassName: vmImage.status.apply(s => {
                    if (!s?.storageClassName) throw new Error(`harvester ${h.name}: imported image ${image.os} has no status.storageClassName`);
                    return s.storageClassName;
                }),
            };
        }

        this.registerOutputs({});
    }
}
