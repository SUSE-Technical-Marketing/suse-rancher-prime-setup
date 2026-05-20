import * as pulumi from "@pulumi/pulumi";
import { management } from "../../generated";

export interface RancherFeatureInputs {
    featureName: string;
    featureValue: pulumi.Input<boolean>;
}

export function setFeatureFlag(args: RancherFeatureInputs, opts?: pulumi.CustomResourceOptions): management.v3.FeaturePatch {
    return new management.v3.FeaturePatch(args.featureName, {
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
