import * as pulumi from "@pulumi/pulumi";
import { harvesterhci } from "@suse-tmm/harvester-crds";

export interface KeyPairArgs {
    name: string;
    namespace?: string;
    publicKey: string;
}

export function createKeyPairs(keyPairs: KeyPairArgs[], opts: pulumi.CustomResourceOptions): Record<string, harvesterhci.v1beta1.KeyPair> {
    const result: Record<string, harvesterhci.v1beta1.KeyPair> = {};
    for (const keyPair of keyPairs) {
        result[keyPair.name] = new harvesterhci.v1beta1.KeyPair(keyPair.name, {
            metadata: {
                name: keyPair.name,
                namespace: keyPair.namespace ?? "default",
            },
            spec: {
                publicKey: keyPair.publicKey,
            },
        }, opts);
    }
    return result;
}