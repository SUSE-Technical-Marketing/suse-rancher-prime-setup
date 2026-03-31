import * as pulumi from "@pulumi/pulumi";
import { k8s } from "@suse-tmm/harvester-crds";

export interface NetworkArgs {
    name: string;
    namespace?: string;
    annotations: Record<string, string>;
    config: string;
}

export function createNetworks(networks: NetworkArgs[], opts: pulumi.CustomResourceOptions): Record<string, k8s.v1.NetworkAttachmentDefinition> {
    const result: Record<string, k8s.v1.NetworkAttachmentDefinition> = {};
    for (const network of networks) {
        result[network.name] = new k8s.v1.NetworkAttachmentDefinition(network.name, {
            metadata: {
                name: network.name,
                namespace: network.namespace ?? "default",
                annotations: network.annotations,
            },
            spec: {
                config: network.config,
            },
        }, opts);
    }
    return result;
}
