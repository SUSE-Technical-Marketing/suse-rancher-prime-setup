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
        NewUser({
            name: "jeroen",
            password: "$2y$10$M8ZamcBlJG4xMooQSI7M2eAy2vrDrFx4WOG79SrPKjZUU/kDpsRE6",
            sudo: "ALL=(ALL) NOPASSWD:ALL",
            sshAuthorizedKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBSE68VYUiwL5a8xcmv34RZ1OYnrEcRBe4NaeKpE/twU jeroen@hierynomus.com",
                "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDmt6+SsXzLoRptifmSKlyjq6grRf4Yb1f2g0Etn7PKUK0LLKO3qZmSEgDwhohALXU7ZhSMVttYgLCjtFd4kG/JEdJVkGSqppLekgpc/T3yG8K3sO78UBdWtnLVY/6MtIHC1GHsAikTuPIJfIqftIk1RZwLKfIIgkT3HQAl9Kzn45QCVj4RrOhekHmqlgePrasTe1HKFRjQ/cuM6cqHSaPNWHrgshlci5BVTS6hqjNxeW/Rb/X4vDcvs/5glRvd0M3ESr1Aii5fhATzHSCGUje2U91ztRDvXdZQNsxQGPP1oTVTRa0oxKutpZee5lMEUjwU6hzoAx3jxPehayFjWJh"
            ]
        }),
        PackageUpdate,
        Packages("curl", "helm", "git-core", "bash-completion", "vim", "nano", "iputils", "wget", "mc", "tree", "btop", "kubernetes-client", "helm", "k9s", "cloud-init"),
        GuestAgent,
        IncreaseFileLimit,
    ]
}]

export class CloudInitTemplate extends kubernetes.core.v1.Secret {
    // getCloudInit(name: string, namespace: string, opts: pulumi.CustomResourceOptions): pulumi.Output<CloudInit> {
    //     const secret = kubernetes.core.v1.Secret.get(name, namespace, opts);
    //     if (!secret) {
    //         throw new Error(`Secret ${name} not found`);
    //     }
    //     pulumi.all([secret.metadata, secret.data]).apply(([metadata, data]) => {
    //         if (metadata.labels["harvesterhci.io/cloud-init-template"] !== "user") {
    //             throw new Error(`Secret ${name} is not a valid cloud-init template`);
    //         }
    //         if (!data?.cloudInit) {
    //             throw new Error(`Secret ${name} does not contain cloud-init data`);
    //         }
    //         return new CloudInit(data.cloudInit);
    //     });
    // }
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


