import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { NetworkAttachmentDefinition } from "../../crds/nodejs/k8s/v1";

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
    opts: pulumi.CustomResourceOptions = {}): NetworkAttachmentDefinition {
    return new NetworkAttachmentDefinition(name, {
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

export function createNetworks(opts: pulumi.CustomResourceOptions): Map<string, NetworkAttachmentDefinition> {
    const networks: Map<string, NetworkAttachmentDefinition> = new Map<string, NetworkAttachmentDefinition>();
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
