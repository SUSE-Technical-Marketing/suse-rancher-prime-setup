import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { cloudInit, CloudInitArgs, CloudInitProcessor, renderCloudInit } from "@suse-tmm/utils";

export interface CloudInitTemplateArgs {
    name: string;
    namespace?: string;
    cloudInit: CloudInitProcessor[];
}

export class CloudInitTemplate extends kubernetes.core.v1.ConfigMap {
    constructor(name: string, cloudInit: CloudInitArgs, opts?: pulumi.CustomResourceOptions) {
        super(name, {
            metadata: {
                name: name,
                labels: {
                    "harvesterhci.io/cloud-init-template": "user",
                },
            },
            data: {
                cloudInit: renderCloudInit(cloudInit),
            },
        }, opts);
    }
}

export function createCloudInitTemplates(templates: CloudInitTemplateArgs[], opts: pulumi.CustomResourceOptions): Record<string, CloudInitTemplate> {
    const result: Record<string, CloudInitTemplate> = {};
    for (const t of templates) {
        result[t.name] = new CloudInitTemplate(t.name, cloudInit(...t.cloudInit), opts);
    }
    return result;
}
