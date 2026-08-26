import * as pulumi from "@pulumi/pulumi";
import { RancherClient, waitFor } from "@suse-tmm/common";

// Rancher templates the registration token out of the manifest URL and stores it in a separate Secret
const TOKEN_PLACEHOLDER = "{token}";

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
        const client = await RancherClient.fromKubeconfig(kubeconfigYaml);

        const crt = await client.get(path).catch((err) => {
            if (err.response?.statusCode === 404) return undefined;
            throw err;
        });

        const manifestUrl: string | undefined = crt?.status?.manifestUrl;
        if (!manifestUrl) return undefined; // Status not populated yet, let waitFor retry

        if (!manifestUrl.includes(TOKEN_PLACEHOLDER)) return manifestUrl;

        // Newer Rancher versions keep the token out of the CRD and only reference the secret holding it
        const tokenSecretName: string | undefined = crt?.status?.tokenSecretName;
        if (!tokenSecretName) return undefined; // Secret not referenced yet, let waitFor retry

        const token = await this.fetchToken(client, namespace, tokenSecretName);
        if (!token) return undefined; // Secret not created/populated yet, let waitFor retry

        return manifestUrl.replace(TOKEN_PLACEHOLDER, token);
    }

    private async fetchToken(client: RancherClient, namespace: string, secretName: string): Promise<string | undefined> {
        const path = `api/v1/namespaces/${namespace}/secrets/${secretName}`;
        const secret = await client.get(path).catch((err) => {
            if (err.response?.statusCode === 404) return undefined;
            throw err;
        });

        const encoded: string | undefined = secret?.data?.token;
        if (!encoded) return undefined;

        const token = Buffer.from(encoded, "base64").toString("utf8").trim();
        return token.length > 0 ? token : undefined;
    }
}

export class ClusterRegistrationToken extends pulumi.dynamic.Resource {
    public readonly token!: pulumi.Output<string>;

    constructor(name: string, args: ClusterRegistrationTokenInputs, opts?: pulumi.CustomResourceOptions) {
        // The resolved manifest URL embeds the registration token, so keep it out of plaintext state
        super(new ClusterRegistrationTokenProvider(), name, { ...args, token: undefined }, {
            ...opts,
            additionalSecretOutputs: [...(opts?.additionalSecretOutputs ?? []), "token"],
        });
    }
}
