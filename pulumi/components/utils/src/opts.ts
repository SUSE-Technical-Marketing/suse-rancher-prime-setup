import * as pulumi from "@pulumi/pulumi"

export function noProvider(opts?: pulumi.ComponentResourceOptions | pulumi.CustomResourceOptions) {
    return (({ provider, ...o }) => o)(opts || {});
}
