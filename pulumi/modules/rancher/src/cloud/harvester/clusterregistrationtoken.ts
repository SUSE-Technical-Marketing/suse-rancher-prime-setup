import * as pulumi from "@pulumi/pulumi";
import { RancherClient, waitFor } from "@suse-tmm/common";

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

    async read(id: pulumi.ID, props?: ClusterRegistrationTokenProviderOutputs): Promise<pulumi.dynamic.ReadResult<ClusterRegistrationTokenProviderOutputs>> {
        if (!props) return { id, props: {} as ClusterRegistrationTokenProviderOutputs };
        const token = await this.fetchClusterRegistrationToken(props.rancherKubeconfig, props.clusterName).catch(() => props.token);
        return {
            id,
            props: { ...props, token: token ?? props.token },
        };
    }

    async fetchClusterRegistrationToken(kubeconfigYaml: string, namespace: string): Promise<string | undefined> {
        const path = `apis/management.cattle.io/v3/namespaces/${namespace}/clusterregistrationtokens/default-token`;
        return RancherClient.fromKubeconfig(kubeconfigYaml).then(async (client) => {
            return client.get(path)
        }).then((body) => body?.status?.manifestUrl).catch((err) => {
            if (err.response?.statusCode === 404) return undefined;
            throw err;
        });
    }
}

export class ClusterRegistrationToken extends pulumi.dynamic.Resource {
    public readonly token!: pulumi.Output<string>;

    constructor(name: string, args: ClusterRegistrationTokenInputs, opts?: pulumi.CustomResourceOptions) {
        super(new ClusterRegistrationTokenProvider(), name, { ...args, token: undefined }, opts);
    }
}
