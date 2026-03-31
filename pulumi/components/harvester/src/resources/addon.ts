import * as pulumi from "@pulumi/pulumi";
import { harvesterhci } from "@suse-tmm/harvester-crds";

export interface HarvesterAddonInputs {
    addonName: string;
    namespace?: string;
    labels?: Record<string, string>;
    enabled: pulumi.Input<boolean>;
    chart?: pulumi.Input<string>;
    repo?: pulumi.Input<string>;
    version?: pulumi.Input<string>;
    valuesContent?: pulumi.Input<string>;
    existingResource?: boolean;
}

export class HarvesterAddon extends pulumi.ComponentResource {
    public readonly addon: harvesterhci.v1beta1.Addon;

    constructor(name: string, args: HarvesterAddonInputs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:harvester:Addon", name, {}, opts);

        const namespace = args.namespace ?? "harvester-system";
        const importId = args.existingResource
            ? `${namespace}/${args.addonName}`
            : undefined;

        this.addon = new harvesterhci.v1beta1.Addon(name, {
            metadata: {
                name: args.addonName,
                namespace: namespace,
                annotations: {
                    "pulumi.com/waitFor": "condition=Completed",
                },
                labels: args.labels,
            },
            spec: {
                enabled: args.enabled,
                chart: args.chart,
                repo: args.repo,
                version: args.version,
                valuesContent: args.valuesContent || "",
            },
        }, {
            parent: this,
            provider: opts?.provider,
            import: importId,
            retainOnDelete: args.existingResource ?? false,
        });

        this.registerOutputs({ addon: this.addon });
    }
}
