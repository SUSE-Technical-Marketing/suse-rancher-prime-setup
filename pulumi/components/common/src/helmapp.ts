import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface HelmAppArgs {
    namespace?: pulumi.Input<string>;
    chart: pulumi.Input<string>;
    version?: pulumi.Input<string>;
    repository?: pulumi.Input<string>;
    values?: pulumi.Input<{[key: string]: any}>;
}

export class HelmApp extends pulumi.ComponentResource {
    public namespaceName: pulumi.Output<string>;
    constructor(name: string, args: HelmAppArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:HelmApp", name, {}, opts);

        // Default namespace to release name if not provided, don't use chart name as it may be an OCI URL
        this.namespaceName = pulumi.output(args.namespace || name);

        const resourceOpts = { ...opts, parent: this, retainOnDelete: true };

        const ns = new k8s.core.v1.Namespace(name, {
                metadata: {
                    name: this.namespaceName,
                },
            }, resourceOpts);
        
        // In case of OCI charts, repository is not needed
        const repoOpts = args.repository ? {
            repo: args.repository,
        } : undefined;

        new k8s.helm.v3.Release(name, {
            name: name,
            chart: args.chart,
            namespace: ns.metadata.name,
            version: args.version,
            repositoryOpts: repoOpts,
            values: args.values,
        }, { ...resourceOpts, dependsOn: [ns] });

        this.registerOutputs({
            namespaceName: this.namespaceName,
        });
    }
}
