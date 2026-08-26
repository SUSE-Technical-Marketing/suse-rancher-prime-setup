import * as pulumi from "@pulumi/pulumi"

export function noProvider(opts?: pulumi.ComponentResourceOptions | pulumi.CustomResourceOptions) {
    return (({ provider, ...o }) => o)(opts || {});
}

/**
 * Add extra dependencies to a set of options without dropping the ones the caller already passed in.
 */
export function withDependsOn<O extends pulumi.ComponentResourceOptions>(opts: O | undefined, ...resources: pulumi.Resource[]): O {
    const prior = opts?.dependsOn;
    const priorList = prior === undefined ? [] : Array.isArray(prior) ? prior : [prior];
    return { ...(opts || {} as O), dependsOn: [...priorList, ...resources] };
}
