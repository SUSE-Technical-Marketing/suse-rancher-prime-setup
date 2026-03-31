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
        pulumi.log.info(`[RancherLoginProvider] Attempting login to "${inputs.server}" as "${inputs.username} / ${inputs.password}" ...`);
        const start = Date.now();

        return RancherClient.fromServerConnectionArgs(inputs).then(client => {
            const elapsed = Date.now() - start;
            pulumi.log.info(`[RancherLoginProvider] Login succeeded in ${elapsed}ms for "${inputs.server}"`);
            return {
                id: `${inputs.server}-login-${inputs.username}`,
                outs: {
                    ...inputs,
                    authToken: (client.details as RancherServerConnectionDetails).token,
                    insecure: inputs.insecure ?? false,
                },
            };
        }).catch(err => {
            const elapsed = Date.now() - start;
            pulumi.log.error(`[RancherLoginProvider] Login failed after ${elapsed}ms: ${err.message}`);
            if (err.code) pulumi.log.error(`[RancherLoginProvider] Error code: ${err.code}`);
            if (err.timings) pulumi.log.error(`[RancherLoginProvider] Timings: ${JSON.stringify(err.timings)}`);
            throw new Error(`Failed to login to Rancher at "${inputs.server}": ${err.message}`);
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
            changes: olds.server !== news.server ||
                        olds.username !== news.username ||
                        olds.password !== news.password ||
                        olds.insecure !== news.insecure,
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
