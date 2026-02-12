import * as pulumi from "@pulumi/pulumi";
import { kubeConfigToHttp, waitFor } from "@suse-tmm/utils";
import got from "got";

interface ClusterRegistrationTokenInputs {
    rancherKubeconfig: pulumi.Input<string>; // Kubeconfig to access the Rancher cluster
    clusterName: pulumi.Input<string>;
}

interface ClusterRegistrationTokenProviderInputs {
    rancherKubeconfig: string; // Kubeconfig to access the Rancher cluster
    clusterName: string;
}

interface ClusterRegistrationTokenProviderOutputs extends ClusterRegistrationTokenProviderInputs {
    token: string;
}

class ClusterRegistrationTokenProvider implements pulumi.dynamic.ResourceProvider<ClusterRegistrationTokenProviderInputs, ClusterRegistrationTokenProviderOutputs> {
    async create(inputs: ClusterRegistrationTokenProviderInputs): Promise<pulumi.dynamic.CreateResult<ClusterRegistrationTokenProviderOutputs>> {
        pulumi.log.info(`Fetching cluster registration token for cluster ${inputs.clusterName}...`);
        return waitFor(() => this.fetchClusterRegistrationToken(inputs.rancherKubeconfig, inputs.clusterName).catch(err => {
            pulumi.log.error(`Failed to fetch cluster registration token for ${inputs.clusterName}: ${err.message}`);
            throw new Error(`Failed to fetch cluster registration token for ${inputs.clusterName}: ${err.message}`);
        }), {
            intervalMs: 5_000,
            timeoutMs: 30 * 1000, // 30 seconds timeout
        }).then((token) => {
            return {
                id: inputs.clusterName,
                outs: {
                    ...inputs,
                    token: token,
                },
            };
        });
    }

    async update(id: pulumi.ID, olds: ClusterRegistrationTokenProviderOutputs, news: ClusterRegistrationTokenProviderInputs): Promise<pulumi.dynamic.UpdateResult<ClusterRegistrationTokenProviderOutputs>> {
        return {
            outs: { ...olds }
        }
    }

    async delete(id: pulumi.ID, props: ClusterRegistrationTokenProviderOutputs): Promise<void> {
        // No action needed for deletion
    }

    async fetchClusterRegistrationToken(kubeconfigYaml: string, namespace: string): Promise<string | undefined> {
        // 2️⃣  parse the kubeconfig -------------------------------------------------
        const httpConfig = kubeConfigToHttp(kubeconfigYaml);
        // 4️⃣  call the VMI endpoint ------------------------------------------------
        const url = `${httpConfig.server}/apis/management.cattle.io/v3/namespaces/${namespace}/clusterregistrationtokens/default-token`;

        return got.get<{ [key: string]: any }>(url, {
            agent: { https: httpConfig.agent },
            headers: httpConfig.headers,
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 5, calculateDelay: () => 5000 },
        }).then((res) => {
            if (res.statusCode === 404) {
                return undefined; // Resource not found
            } else if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`Failed to fetch cluster registration token: ${res.statusMessage}`);
            }

            return res.body?.status?.manifestUrl;
        });
    }
}

export class ClusterRegistrationToken extends pulumi.dynamic.Resource {
    public readonly token!: pulumi.Output<string>;

    constructor(name: string, args: ClusterRegistrationTokenInputs, opts?: pulumi.CustomResourceOptions) {
        super(new ClusterRegistrationTokenProvider(), name, { ...args, token: undefined }, opts);
    }
}
