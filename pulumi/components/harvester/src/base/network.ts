import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { k8s } from "@suse-tmm/harvester-crds";

interface NetworkDefinition {
    name: string;
    annotations: { [key: string]: string };
    config: string;
}

const DefaultNetworks = [
    {
        name: "backbone-vlan",
        annotations: {
            "network.harvesterhci.io/clusternetwork": "mgmt",
            "network.harvesterhci.io/ready": "true",
            "network.harvesterhci.io/type": "UntaggedNetwork"
        },
        config: "{\"cniVersion\":\"0.3.1\",\"name\":\"backbone\",\"type\":\"bridge\",\"bridge\":\"mgmt-br\",\"promiscMode\":true,\"ipam\":{}}"
    }
] as NetworkDefinition[];

function createNetworkAttachmentDefinition(
    name: string,
    annotations: { [key: string]: string },
    config: string,
    opts: pulumi.CustomResourceOptions = {}): k8s.v1.NetworkAttachmentDefinition {
    return new k8s.v1.NetworkAttachmentDefinition(name, {
        metadata: {
            name: name,
            namespace: "default",
            annotations: annotations
        },
        spec: {
            config: config
        }
    }, opts);
}

export function createNetworks(opts: pulumi.CustomResourceOptions): Map<string, k8s.v1.NetworkAttachmentDefinition> {
    const networks: Map<string, k8s.v1.NetworkAttachmentDefinition> = new Map<string, k8s.v1.NetworkAttachmentDefinition>();
    DefaultNetworks.forEach((network) => {
        networks.set(network.name, createNetworkAttachmentDefinition(
            network.name,
            network.annotations,
            network.config,
            opts
        ));
    });
    return networks;
}
