import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { KubeConfigHttpOutput, kubeConfigToHttp, waitFor } from "@suse-tmm/utils";
import got from "got";

export interface BootstrapAdminPasswordArgs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Rancher API
    rancherUrl: pulumi.Input<string>; // URL of the Rancher server
    password?: pulumi.Input<string>;
}

interface BootstrapAdminPasswordProviderInputs {
    kubeconfig: string; // Kubeconfig to access the Rancher API
    rancherUrl: string; // URL of the Rancher server
    password?: string;
}

interface BootstrapAdminPasswordProviderOutputs extends BootstrapAdminPasswordProviderInputs {}

class BootstrapAdminPasswordProvider implements dynamic.ResourceProvider<BootstrapAdminPasswordProviderInputs, BootstrapAdminPasswordProviderOutputs> {
    async create(inputs: BootstrapAdminPasswordProviderInputs): Promise<dynamic.CreateResult<BootstrapAdminPasswordProviderOutputs>> {
        let password = inputs.password;
        const username = "admin"; // Default username for Rancher admin
        if (!password || password === "") {
            pulumi.log.warn("No password provided for Rancher admin user. A random password will be generated.");
            // generate random password if not provided
            password = Math.random().toString(36).slice(-8);
        }

        const httpConfig = kubeConfigToHttp(inputs.kubeconfig);

        // Fetch the bootstrap token from the Rancher API
        const newPassword = await waitFor(() => this.fetchBootstrapToken(httpConfig).catch(err => {
            pulumi.log.error(`Failed to fetch bootstrap token: ${err.message}`);
            throw new Error(`Failed to fetch bootstrap token: ${err.message}`);
        }), {
            intervalMs: 5_000,
            timeoutMs: 300_000, // 5 minutes
        }).then(async token => {
            return {
                bootstrapToken: token,
                authToken: await this.loginToRancher(inputs.rancherUrl, username, token).catch(err => {
                    pulumi.log.error(`Failed to login to Rancher with bootstrap token: ${err.message}`);
                    throw new Error(`Failed to login to Rancher with bootstrap token: ${err.message}`);
                })
            };
        }).then(obj => {
            this.updatePassword(inputs.rancherUrl, username, obj.authToken, obj.bootstrapToken, password).catch(err => {
                pulumi.log.error(`Failed to update password for user ${username}: ${err.message}`);
                throw new Error(`Failed to update password for user ${username}: ${err.message}`);
            });
            return password;
        }).catch(err => {
            pulumi.log.error(`Failed to complete password setup: ${err.message}`);
            throw new Error(`Failed to complete password setup: ${err.message}`);
        });

        return {
            id: `cattle-system/bootstrap-password-${new Date().toISOString()}`,
            outs: {
                ...inputs,
                password: newPassword,
            },
        };
    }

    async updatePassword(server: string, username: string, token: string, password: string, newPassword: string): Promise<void> {
        const url = `${server}/v3/users?action=changepassword`;

        const res = await got.post(url, {
            headers: {
                "Authorization": `Bearer ${token}`
            },
            json: {
                currentPassword: password,
                newPassword: newPassword,
            },
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Failed to update password for user ${username}: ${res.statusCode} ${res.statusMessage}`);
        }
    }

    async loginToRancher(server: string, username: string, password: string): Promise<string> {
        const url = `${server}/v3-public/localProviders/local?action=login`;
        const res: any = await got.post(url, {
            json: {
                username: username,
                password: password,
            },
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
        }

        const token = res.body?.["token"];
        return token;
    }

    async fetchBootstrapToken(httpConfig: KubeConfigHttpOutput): Promise<string | undefined> {
        const url = `${httpConfig.server}/api/v1/namespaces/cattle-system/secrets/bootstrap-secret`;
        const res: any = await got.get(url, {
            agent: { https: httpConfig.agent },
            headers: httpConfig.headers,
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });

        if (res.statusCode !== 200) {
            throw new Error(`Failed to fetch bootstrap token: ${res.statusCode} ${res.statusMessage}`);
        }

        const bootstrapToken = res.body?.data?.["bootstrapPassword"];
        const deBase64Token = bootstrapToken ? Buffer.from(bootstrapToken, "base64").toString("utf-8") : undefined;

        return deBase64Token
    }
}

export class BootstrapAdminPassword extends dynamic.Resource {
    public readonly password!: pulumi.Output<string>;
    public readonly username!: pulumi.Output<string>;

    constructor(name: string, args: BootstrapAdminPasswordArgs, opts?: pulumi.ComponentResourceOptions) {
        super(new BootstrapAdminPasswordProvider(), name, args, { ...opts, additionalSecretOutputs: ["password"] });
    }
}
