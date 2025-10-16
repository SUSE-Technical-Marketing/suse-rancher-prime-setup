import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { BashRcLocal, cloudInit, CloudInitArgs, CloudInitProcessor, DefaultUser, DisableIpv6, GuestAgent, IncreaseFileLimit, KubeFirewall, NewUser, Packages, PackageUpdate, renderCloudInit } from "@suse-tmm/utils";

export interface CloudInitTemplateArgs {
    name: string;
    namespace: string;
    cloudInit: CloudInitProcessor[];
}

const DefaultCloudInitTemplates: CloudInitTemplateArgs[] = [{
    name: "opensuse-full-node",
    namespace: "default",
    cloudInit: [
        BashRcLocal,
        KubeFirewall,
        DisableIpv6,
        DefaultUser,
        PackageUpdate,
        Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),
        GuestAgent,
        IncreaseFileLimit,
    ]
}]

export class CloudInitTemplate extends kubernetes.core.v1.Secret {
    constructor(name: string, cloudInit: CloudInitArgs, opts?: pulumi.CustomResourceOptions) {
        super(name, {
            metadata: {
                labels: {
                    "harvesterhci.io/cloud-init-template": "user",
                },
            },
            stringData: {
                cloudInit: renderCloudInit(cloudInit),
            }
        }, opts);
    }
}

export function createCloudInitTemplates(sshUser: string, sshPubKey: string, opts: pulumi.CustomResourceOptions) : Map<string, CloudInitTemplate> {
    const templates = new Map<string, CloudInitTemplate>();
    for (const templateArgs of DefaultCloudInitTemplates) {
        templateArgs.cloudInit = [...templateArgs.cloudInit, NewUser({
            name: sshUser,
            sudo: "ALL=(ALL) NOPASSWD:ALL",
            sshAuthorizedKeys: [sshPubKey],
            password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
        })];
        const template = new CloudInitTemplate(templateArgs.name, cloudInit(...templateArgs.cloudInit), opts);
        templates.set(templateArgs.name, template);
    }
    return templates;
}


