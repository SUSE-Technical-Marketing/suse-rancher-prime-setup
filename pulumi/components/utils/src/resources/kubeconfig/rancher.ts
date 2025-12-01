import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { KubeConfig } from ".";
import { RancherClient } from "../../rancher-client";
import { RancherLoginInputs, RancherLoginProviderInputs } from "../rancherlogin";

export interface RancherKubeconfigInputs {
    rancher: RancherLoginInputs;
    clusterId: pulumi.Input<string>;
}

interface RancherKubeconfigProviderInputs {
    rancher: RancherLoginProviderInputs;
    clusterId: string;
}

interface RancherKubeconfigProviderOutputs extends RancherKubeconfigProviderInputs {
    kubeconfig: string;
}

class RancherKubeconfigProvider implements dynamic.ResourceProvider<RancherKubeconfigProviderInputs, RancherKubeconfigProviderOutputs> {
    private readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    create(inputs: RancherKubeconfigProviderInputs): Promise<dynamic.CreateResult<RancherKubeconfigProviderOutputs>> {

        return RancherClient.fromServerConnectionArgs(inputs.rancher).then(client => {
            pulumi.log.info(`Successfully logged in to Rancher`);
            return this.downloadKubeconfig(client, inputs.clusterId).then(kubeconfig => {
                return {
                    client: client,
                    kubeconfig: kubeconfig,
                };
            });
        }).then(({ client, kubeconfig }) => {
            pulumi.log.info(`Successfully downloaded kubeconfig for cluster ${inputs.clusterId}`);
            if (client.details.insecure) {
                kubeconfig = new KubeConfig(kubeconfig).insecure().kubeconfig;
            }
            pulumi.log.info(`Resulting kubeconfig = ${kubeconfig}`);
            return { id: `${inputs.clusterId}-${Date.now()}`, outs: { ...inputs, kubeconfig: kubeconfig } };
        }).catch(error => {
            console.error("Error creating Rancher kubeconfig:", error);
            throw error;
        });
    }

    async diff(_id: string, _olds: RancherKubeconfigProviderOutputs, _news: RancherKubeconfigProviderInputs): Promise<dynamic.DiffResult> {
        return {
            changes: JSON.stringify(_olds.rancher) !== JSON.stringify(_news.rancher),
        }
    }

    async update(id: string, _olds: RancherKubeconfigProviderOutputs, news: RancherKubeconfigProviderInputs): Promise<dynamic.UpdateResult> {
        // For simplicity, re-run create logic.
        return this.create(news);
    }

    downloadKubeconfig(client: RancherClient, clusterId: string): Promise<string> {
        // return client.post(`/v1/management.cattle.io.clusters/${clusterId}`, { action: "generateKubeconfig" }).then(response => {
        return client.post(`${this.path}/${clusterId}`, "", { action: "generateKubeconfig" }).then(response => {
            return response.config;
        }).catch(error => {
            console.error("Error generating kubeconfig:", error);
            throw error;
        });
    }

}

export class RancherKubeconfig extends dynamic.Resource {
    public readonly kubeconfig!: pulumi.Output<string>;

    constructor(name: string, args: RancherKubeconfigInputs, opts?: pulumi.ResourceOptions) {
        super(new RancherKubeconfigProvider("/v3/clusters"), name, { kubeconfig: undefined, ...args }, { ...opts, additionalSecretOutputs: ["kubeconfig"] });

    }
}
export class HarvesterKubeconfig extends dynamic.Resource {
    public readonly kubeconfig!: pulumi.Output<string>;

    constructor(name: string, args: RancherKubeconfigInputs, opts?: pulumi.ResourceOptions) {
        super(new RancherKubeconfigProvider("/v1/management.cattle.io.clusters"), name, { kubeconfig: undefined, ...args }, { ...opts, additionalSecretOutputs: ["kubeconfig"] });

    }
}
