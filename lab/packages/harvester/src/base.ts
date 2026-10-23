import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { harvesterhci, k8s as cni, loadbalancer, network } from "@lab/crds";
import type { ResolvedHarvester } from "@lab/schema";
import { HarvesterAddon } from "./addon";
import { LoadBalancerCleanup } from "./lb-cleanup";

export interface Credentials {
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
}

export interface HarvesterBaseArgs {
    harvester: ResolvedHarvester;
    /** Namespace on the Harvester that holds everything the lab creates there. */
    namespace: string;
    domain: string;
    ssh: { user: string; publicKey: string };
    /** Networks hosts or downstream pools use; only these (and networks with DHCP) are created. */
    usedNetworks: string[];
    dnsCredentials?: Credentials;
    versions: { dhcpController: string; dnsController: string };
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
 * class, VM networks with DHCP, the DNS controller, the SSH key pair and the OS images. Nothing
 * here is retained on delete: a destroyed lab leaves the Harvester as it found it.
 */
export class HarvesterBase extends pulumi.ComponentResource {
    readonly namespace: k8s.core.v1.Namespace;
    /** Network name (`untagged`, `vlan20`) -> `namespace/name` for VM interfaces. */
    readonly networks: Record<string, pulumi.Output<string>> = {};
    /** OS name -> image. */
    readonly images: Record<string, HarvesterImage> = {};
    /** What a VM on this Harvester has to wait for (networks, DHCP pools, DNS controller). */
    readonly ready: pulumi.Resource[] = [];

    constructor(name: string, args: HarvesterBaseArgs, opts: pulumi.ComponentResourceOptions & { provider: k8s.Provider }) {
        super("lab:harvester:Base", name, {}, opts);
        const h = args.harvester;
        const child = (suffix: string) => `${name}/${suffix}`;
        const o: pulumi.CustomResourceOptions = { parent: this, provider: opts.provider };

        this.namespace = new k8s.core.v1.Namespace(child("namespace"), {
            metadata: { name: args.namespace, labels: { "app.kubernetes.io/managed-by": "lab" } },
        }, o);
        const ns = this.namespace.metadata.name;
        const inNs: pulumi.CustomResourceOptions = { ...o, dependsOn: [this.namespace] };

        new k8s.storage.v1.StorageClass(child("storageclass"), {
            metadata: { name: h.storageClass.name },
            provisioner: "driver.longhorn.io",
            allowVolumeExpansion: true,
            reclaimPolicy: "Delete",
            volumeBindingMode: "Immediate",
            parameters: {
                numberOfReplicas: String(h.storageClass.replicas),
                staleReplicaTimeout: "30",
                migratable: "true",
            },
        }, o);

        // --- Networks and DHCP ---------------------------------------------------------------
        const networks = h.networks.filter(n => args.usedNetworks.includes(n.name) || n.dhcp || n.loadBalancer);
        const dhcpNeeded = networks.some(n => n.dhcp);
        const dhcpAddon = dhcpNeeded ? new HarvesterAddon(child("dhcp-controller"), {
            harvester: h.name,
            name: "harvester-vm-dhcp-controller",
            namespace: "harvester-system",
            labels: { "addon.harvesterhci.io/experimental": "true" },
            repo: "https://charts.harvesterhci.io",
            chart: "harvester-vm-dhcp-controller",
            version: args.versions.dhcpController,
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
            this.ready.push(new LoadBalancerCleanup(child("lb-cleanup"), { harvester: h.name, namespace: ns }, { parent: this, dependsOn: pools }));
        }

        // --- DNS controller --------------------------------------------------------------------
        if (h.dns && args.dnsCredentials) {
            const secret = new k8s.core.v1.Secret(child("dns-controller-secret"), {
                metadata: { name: "lab-dns-controller", namespace: "harvester-system" },
                stringData: { password: pulumi.secret(args.dnsCredentials.password) },
            }, o);
            this.ready.push(new k8s.helm.v3.Release(child("dns-controller"), {
                name: "harvester-dns-controller",
                namespace: "harvester-system",
                chart: "oci://ghcr.io/hierynomus/harvester-dns-controller/charts/harvester-dns-controller",
                version: args.versions.dnsController,
                values: {
                    dns: {
                        backend: h.dns.backend,
                        host: h.dns.host,
                        username: args.dnsCredentials.username,
                        existingSecret: "lab-dns-controller",
                        useTls: false,
                        domain: args.domain,
                    },
                    watchNamespaces: ns,
                },
            }, { ...o, dependsOn: [secret] }));
        }

        // --- SSH key pair and images --------------------------------------------------------------
        new harvesterhci.v1beta1.KeyPair(child("keypair"), {
            metadata: { name: args.ssh.user, namespace: ns },
            spec: { publicKey: args.ssh.publicKey },
        }, inNs);

        for (const image of h.images) {
            if (image.source.kind === "file") {
                throw new Error(`harvester ${h.name}: uploading local image files (${image.os}) is not implemented yet; use a url for now`);
            }
            const vmImage = new harvesterhci.v1beta1.VirtualMachineImage(child(`image/${image.os}`), {
                metadata: {
                    name: image.os,
                    namespace: ns,
                    annotations: { [WAIT]: "condition=Imported", [TIMEOUT]: "3600" },
                },
                spec: {
                    displayName: image.os,
                    sourceType: "download",
                    url: image.source.url,
                    storageClassParameters: {
                        numberOfReplicas: String(h.storageClass.replicas),
                        staleReplicaTimeout: "30",
                        migratable: "true",
                    },
                },
            }, {
                ...inNs,
                // Harvester fills in its own storageClassParameters and rejects any change to them;
                // a different image means a new image.
                ignoreChanges: ["spec.storageClassParameters"],
                replaceOnChanges: ["spec.url", "spec.sourceType"],
                deleteBeforeReplace: true,
            });
            this.images[image.os] = {
                id: pulumi.interpolate`${ns}/${image.os}`,
                // Harvester creates a storage class per image; VM disks cloned from it must use it.
                storageClassName: vmImage.status.apply(s => s?.storageClassName ?? ""),
            };
        }

        this.registerOutputs({});
    }
}
