import * as pulumi from "@pulumi/pulumi";
import {dynamic} from "@pulumi/pulumi";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";

export interface CloudCredentialInputs {
    rancher: RancherLoginInputs;
    credentialName: pulumi.Input<string>;
    harvesterClusterId: pulumi.Input<string>;
    harvesterKubeconfig: pulumi.Input<string>;
    annotations?: pulumi.Input<{ [key: string]: string }>;
}

export interface CloudCredentialProviderInputs {
    rancher: RancherLoginProviderInputs;
    credentialName: string;
    harvesterClusterId: string;
    harvesterKubeconfig: string;
    annotations?: { [key: string]: string };
}

export interface CloudCredentialProviderOutputs extends CloudCredentialProviderInputs { }

class CloudCredentialProvider implements dynamic.ResourceProvider<CloudCredentialProviderInputs, CloudCredentialProviderOutputs> {
    async create(inputs: CloudCredentialProviderInputs): Promise<dynamic.CreateResult<CloudCredentialProviderOutputs>> {
        const { credentialName, harvesterClusterId, harvesterKubeconfig, annotations } = inputs;

        const body = {
            type: "provisioning.cattle.io/cloud-credential",
            _type: "provisioning.cattle.io/cloud-credential",
            _name: credentialName,
            name: credentialName,
            annotations: annotations || {},
            harvestercredentialConfig: {
                clusterId: harvesterClusterId,
                kubeconfigContent: harvesterKubeconfig,
            },
            metadata: {
                name: credentialName,
                namespace: "fleet-default",
            }
        };

        return RancherClient.fromServerConnectionArgs(inputs.rancher).then(async (rancherClient) => {
            return rancherClient.post(`/v3/cloudcredentials`, body).then((response) => {
                return {
                    id: response.id,
                    outs: {
                        ...inputs,
                    },
                };
            });
        });
    }

    async delete(id: pulumi.ID, props: CloudCredentialProviderOutputs): Promise<void> {
    }

    async update(id: pulumi.ID, olds: CloudCredentialProviderOutputs, news: CloudCredentialProviderInputs): Promise<dynamic.UpdateResult<CloudCredentialProviderOutputs>> {
        return this.create(news);
    }

    async diff(id: pulumi.ID, olds: CloudCredentialProviderOutputs, news: CloudCredentialProviderInputs): Promise<dynamic.DiffResult> {
        return { changes: JSON.stringify(olds) !== JSON.stringify(news) };
    }
}

export class CloudCredential extends dynamic.Resource {
    constructor(name: string, args: CloudCredentialInputs, opts?: pulumi.ResourceOptions) {
        super(new CloudCredentialProvider(), name, {
            ...args,
            name: name,
        }, opts);
    }
}