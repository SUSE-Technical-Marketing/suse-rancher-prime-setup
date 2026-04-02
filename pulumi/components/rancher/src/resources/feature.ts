import * as pulumi from "@pulumi/pulumi";
import { management } from "@suse-tmm/rancher-crds";

export interface RancherFeatureInputs {
    featureName: string;
    featureValue: pulumi.Input<boolean>;
}

export function setFeatureFlag(args: RancherFeatureInputs, opts?: pulumi.CustomResourceOptions): management.FeaturePatch {
    return new management.FeaturePatch(args.featureName, {
        metadata: {
            name: args.featureName,
            annotations: {
                "pulumi.com/patchForce": "true",
            },
        },
        spec: {
            value: args.featureValue,
        },
    }, {
        ...opts,
        retainOnDelete: true,
    });
}
