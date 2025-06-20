import * as pulumi from "@pulumi/pulumi";
import got from "got";
import https from "https";
import * as yaml from "js-yaml";
import * as dynamic from "@pulumi/pulumi/dynamic";

export interface RancherKubeconfigResourceInputs {
    url: pulumi.Input<string>;
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>;
}

export interface RancherKubeconfigInputs {
    url: string;
    username: string;
    password: string;
    clusterName: string;
    insecure?: boolean;
}

export interface RancherKubeconfigOutputs extends RancherKubeconfigInputs{
    kubeconfig: string;
}

class RancherKubeconfigProvider implements dynamic.ResourceProvider<RancherKubeconfigInputs, RancherKubeconfigOutputs> {

    create(inputs: RancherKubeconfigInputs): Promise<dynamic.CreateResult<RancherKubeconfigOutputs>> {
        const { url, username, password, clusterName, insecure } = inputs;
        // Handle self-signed certs
        const httpsAgent = new https.Agent({
            rejectUnauthorized: false,
        });

        return loginRancher(url, username, password, httpsAgent).then(token => {
            pulumi.log.info(`Successfully logged in to Rancher at ${url} as ${username}, token: ${token.substring(0, 10)}...`);
            return downloadKubeconfig(url, clusterName, token, httpsAgent);
        }).then(kubeconfig => {
            pulumi.log.info(`Successfully downloaded kubeconfig for cluster ${clusterName}`);
            if (insecure) {
                const kubeyaml = yaml.load(kubeconfig) as any;
                if (!kubeyaml.clusters || kubeyaml.clusters.length === 0) {
                    throw new Error("Invalid kubeconfig: No clusters found.");
                }
                kubeyaml.clusters[0].cluster["insecure-skip-tls-verify"] = true;
                delete kubeyaml.clusters[0].cluster["certificate-authority-data"];
                kubeconfig = yaml.dump(kubeyaml);
            }
            pulumi.log.info(`Resulting kubeconfig = ${kubeconfig}`);
            return { id: `${clusterName}-${Date.now()}`, outs: { ...inputs, kubeconfig: kubeconfig } };
        }).catch(error => {
            console.error("Error creating Rancher kubeconfig:", error);
            throw error;
        });
    }

    async diff(_id: string, _olds: RancherKubeconfigOutputs, _news: RancherKubeconfigInputs): Promise<dynamic.DiffResult> {
        return {
            changes: _olds.url !== _news.url ||
                _olds.username !== _news.username ||
                _olds.password !== _news.password ||
                _olds.clusterName !== _news.clusterName ||
                _olds.insecure !== _news.insecure
        }
    }

    async update(id: string, _olds: RancherKubeconfigOutputs, news: RancherKubeconfigInputs): Promise<dynamic.UpdateResult> {
        // For simplicity, re-run create logic.
        return this.create(news);
    }
}

export class RancherKubeconfig extends dynamic.Resource {
    public readonly kubeconfig!: pulumi.Output<string>;

    constructor(name: string, args: RancherKubeconfigResourceInputs, opts?: pulumi.ResourceOptions) {
        super(new RancherKubeconfigProvider(), name, { kubeconfig: undefined, ...args }, {...opts, additionalSecretOutputs: ["kubeconfig"]});

    }
}

function loginRancher(url: string, username: string, password: string, agent: https.Agent): Promise<string> {
    return got.post < { token: string }>(`${url}/v3-public/localProviders/local?action=login`, {
        json: { username, password },
        agent: { https: agent },
        responseType: 'json'
    })
    .then(response => response.body.token)
    .catch(error => {
        console.error("Error logging in to Rancher:", error);
        throw error;
    });
}

function downloadKubeconfig(url: string, clusterName: string, bearerToken: string, agent: https.Agent): Promise<string> {
    return got.post<{ [key: string]: any }>(`${url}/v1/management.cattle.io.clusters/${clusterName}?action=generateKubeconfig`, {
        agent: { https: agent },
        headers: { Authorization: `Bearer ${bearerToken}` },
        responseType: 'json'
    })
    .then(response => {
        return response.body.config;
    })
    .catch(error => {
        console.error("Error generating kubeconfig:", error);
        throw error;
    });
}
