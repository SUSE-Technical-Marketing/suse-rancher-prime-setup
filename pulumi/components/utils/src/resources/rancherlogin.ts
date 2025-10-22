import *  as pulumi from "@pulumi/pulumi";
import { RancherClient, RancherServerConnectionDetails } from "../rancher-client";

export interface RancherLoginInputs {
    server: pulumi.Input<string>;
    username?: pulumi.Input<string>;
    password?: pulumi.Input<string>;
    authToken?: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>;
}

export interface RancherLoginProviderInputs {
    server: string;
    username?: string;
    password?: string;
    authToken?: string;
    insecure?: boolean;
}

interface RancherLoginProviderOutputs extends RancherLoginProviderInputs {
    authToken: string;
    insecure: boolean;
}

export interface RancherAuth {
    server: pulumi.Output<string>;
    authToken: pulumi.Output<string>;
    insecure: pulumi.Output<boolean>;
}

class RancherLoginProvider implements pulumi.dynamic.ResourceProvider<RancherLoginProviderInputs, RancherLoginProviderOutputs> {
    async create(inputs: RancherLoginProviderInputs): Promise<pulumi.dynamic.CreateResult<RancherLoginProviderOutputs>> {
        return RancherClient.fromServerConnectionArgs(inputs).catch(err => {
            pulumi.log.error(`Failed to login to Rancher: ${err.message}`);
            throw new Error(`Failed to login to Rancher: ${err.message}`);
        }).then(client => {
            pulumi.log.info(`Successfully logged in to Rancher server: "${inputs.server}" as user: "${inputs.username}"`);
            return {
                id: `${inputs.server}-login-${inputs.username}`,
                outs: {
                    ...inputs,
                    authToken: (client.details as RancherServerConnectionDetails).token,
                    insecure: inputs.insecure ?? false,
                },
            };
        });
    }

    async delete(): Promise<void> {
        // No specific cleanup needed for login
    }

    async update(id: pulumi.ID, olds: RancherLoginProviderOutputs, news: RancherLoginProviderInputs): Promise<pulumi.dynamic.UpdateResult<RancherLoginProviderOutputs>> {
        // For login, we can treat update as a re-login
        return this.create(news);
    }

    async diff(id: pulumi.ID, olds: RancherLoginProviderOutputs, news: RancherLoginProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        // For login, we can assume that any change in inputs requires a re-login
        return {
            changes: true,
            replaces: ["authToken"], // We will replace the authToken on update
        };
    }
}

export class RancherLogin extends pulumi.dynamic.Resource {
    public readonly authToken!: pulumi.Output<string>;
    public readonly server!: pulumi.Output<string>;
    public readonly insecure!: pulumi.Output<boolean>;

    constructor(name: string, inputs: RancherLoginInputs, opts?: pulumi.ComponentResourceOptions) {
        const provider = new RancherLoginProvider();
        super(provider, name, { ...inputs, authToken: undefined}, { ...opts, additionalSecretOutputs: ["authToken"] });
    }

    getAuth(): RancherAuth {
        return {
            insecure: this.insecure,
            server: this.server,
            authToken: this.authToken,
        };
    }
}
