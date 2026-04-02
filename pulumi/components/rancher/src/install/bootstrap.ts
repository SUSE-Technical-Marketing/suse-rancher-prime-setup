import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { KubeConfigHttpOutput, kubeConfigToHttp, waitFor } from "@suse-tmm/utils";
import { loginToRancher } from "@suse-tmm/utils";
import got from "got";

export interface BootstrapAdminPasswordArgs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Rancher API
    rancherUrl: pulumi.Input<string>; // URL of the Rancher server
    adminPassword?: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>; // Whether to skip TLS verification (e.g., when using staging certs)
}

interface BootstrapAdminPasswordProviderInputs {
    kubeconfig: string; // Kubeconfig to access the Rancher API
    rancherUrl: string; // URL of the Rancher server
    adminPassword?: string;
    insecure?: boolean; // Whether to skip TLS verification (e.g., when using staging certs)
}

interface BootstrapAdminPasswordProviderOutputs extends BootstrapAdminPasswordProviderInputs {
    username: string; // Username for Rancher admin user
    password: string; // Password for Rancher admin user
}


class BootstrapAdminPasswordProvider implements dynamic.ResourceProvider<BootstrapAdminPasswordProviderInputs, BootstrapAdminPasswordProviderOutputs> {
    async create(inputs: BootstrapAdminPasswordProviderInputs): Promise<dynamic.CreateResult<BootstrapAdminPasswordProviderOutputs>> {
        let password = inputs.adminPassword;
        const username = "admin"; // Default username for Rancher admin
        if (!password || password === "") {
            pulumi.log.warn("No password provided for Rancher admin user. A random password will be generated.");
            // generate random password if not provided
            password = Math.random().toString(36).slice(-8);
        }

        const httpConfig = kubeConfigToHttp(inputs.kubeconfig);
        const start = Date.now();

        // Fetch the bootstrap token from the Rancher API
        return waitFor(() => this.fetchBootstrapToken(httpConfig), {
            intervalMs: 5_000,
            timeoutMs: 300_000, // 5 minutes
        }).catch(err => {
            pulumi.log.error(`[Bootstrap] Failed to fetch bootstrap token after ${Date.now() - start}ms: ${err.message}`);
            throw err;
        }).then(bootstrapToken => {
            pulumi.log.info(`[Bootstrap] Fetched bootstrap token in ${Date.now() - start}ms, logging in...`);
            return loginToRancher({
                server: inputs.rancherUrl,
                username: username,
                password: bootstrapToken,
                insecure: inputs.insecure,
            }).catch(err => {
                pulumi.log.error(`[Bootstrap] Failed to login with bootstrap token: ${err.message}`);
                throw err;
            }).then(authToken => ({ bootstrapToken, authToken }));
        }).then(({ bootstrapToken, authToken }) => {
            pulumi.log.info("[Bootstrap] Login successful, waiting 5s for Rancher to settle...");
            return new Promise<void>(resolve => setTimeout(resolve, 5000))
                .then(() => ({ bootstrapToken, authToken }));
        }).then(({ bootstrapToken, authToken }) => {
            pulumi.log.info(`[Bootstrap] Updating password for user "${username}"...`);
            return this.updatePassword(inputs.rancherUrl, username, authToken, bootstrapToken, password!, inputs.insecure);
        }).then(() =>{
            pulumi.log.info(`[Bootstrap] Password update complete, logging in with new password to verify...`);
            return loginToRancher({
                server: inputs.rancherUrl,
                username: username,
                password: password!,
                insecure: inputs.insecure,
            }).catch(err => {
                pulumi.log.error(`[Bootstrap] Failed to login with new password: ${err.message}`);
                throw err;
            })
        }).then(() => {
            pulumi.log.info(`[Bootstrap] Password updated successfully in ${Date.now() - start}ms total.`);
            return {
                id: `cattle-system/bootstrap-password-${new Date().toISOString()}`,
                outs: {
                    ...inputs,
                    username: username,
                    password: password!,
                }
            };
        });
    }

    async updatePassword(server: string, username: string, token: string, password: string, newPassword: string, insecure?: boolean): Promise<void> {
        const url = `${server}/v3/users?action=changepassword`;
        const retryLimit = 3;

        pulumi.log.info(`[Bootstrap] POST ${url} (changepassword for "${username}")`);

        const res = await got.post(url, {
            headers: {
                "Authorization": `Bearer ${token}`
            },
            https: {
                rejectUnauthorized: !insecure,
            },
            json: {
                currentPassword: password,
                newPassword: newPassword,
            },
            throwHttpErrors: false,
            responseType: "json",
            timeout: {
                lookup: 5000,
                connect: 5000,
                secureConnect: 5000,
                request: 30000,
            },
            retry: {
                limit: retryLimit,
                calculateDelay: ({ attemptCount }) => {
                    if (attemptCount > retryLimit) {
                        pulumi.log.error(`[Bootstrap] Password update: retry limit reached (${retryLimit}), giving up.`);
                        return 0;
                    }
                    pulumi.log.warn(`[Bootstrap] Password update: retry ${attemptCount}/${retryLimit} in 5s...`);
                    return 5000;
                }
            },
            hooks: {
                beforeRequest: [
                    options => { pulumi.log.info(`[Bootstrap] Sending password update to ${options.url}`); },
                ],
                beforeError: [
                    error => {
                        pulumi.log.error(`[Bootstrap] Password update error: code=${error.code ?? 'N/A'} message="${error.message}"`);
                        return error;
                    },
                ],
            },
        });

        pulumi.log.info(`[Bootstrap] Password update response: ${res.statusCode} ${res.statusMessage}`);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Failed to update password for user ${username}: ${res.statusCode} ${res.statusMessage}`);
        }
    }

    async fetchBootstrapToken(httpConfig: KubeConfigHttpOutput): Promise<string | undefined> {
        const url = `${httpConfig.server}/api/v1/namespaces/cattle-system/secrets/bootstrap-secret`;
        const retryLimit = 5;

        pulumi.log.info(`[Bootstrap] GET ${url}`);

        return got.get<{ [key: string]: any }>(url, {
            agent: { https: httpConfig.agent },
            headers: httpConfig.headers,
            responseType: "json",
            timeout: {
                lookup: 5000,
                connect: 5000,
                secureConnect: 5000,
                request: 15000,
            },
            retry: {
                limit: retryLimit,
                calculateDelay: ({ attemptCount }) => {
                    if (attemptCount > retryLimit) {
                        pulumi.log.error(`[Bootstrap] Fetch bootstrap token: retry limit reached (${retryLimit}), giving up.`);
                        return 0;
                    }
                    pulumi.log.warn(`[Bootstrap] Fetch bootstrap token: retry ${attemptCount}/${retryLimit} in 5s...`);
                    return 5000;
                }
            },
            hooks: {
                beforeRequest: [
                    options => { pulumi.log.info(`[Bootstrap] Sending request to ${options.url}`); },
                ],
                beforeError: [
                    error => {
                        pulumi.log.error(`[Bootstrap] Fetch token error: code=${error.code ?? 'N/A'} message="${error.message}"`);
                        return error;
                    },
                ],
            },
        }).then(res => {
            if (res.statusCode !== 200) {
                throw new Error(`Failed to fetch bootstrap token: ${res.statusCode} ${res.statusMessage}`);
            }
            const bootstrapToken = res.body?.data?.["bootstrapPassword"];
            return bootstrapToken ? Buffer.from(bootstrapToken, "base64").toString("utf-8") : undefined;
        });
    }

    async diff(id: pulumi.ID, olds: BootstrapAdminPasswordProviderOutputs, news: BootstrapAdminPasswordProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return {
            changes: false,
        }
    }

    async update(id: pulumi.ID, olds: BootstrapAdminPasswordProviderOutputs, news: BootstrapAdminPasswordProviderInputs): Promise<pulumi.dynamic.UpdateResult<BootstrapAdminPasswordProviderOutputs>> {
        return { outs: { ...olds } };
    }
}

export class BootstrapAdminPassword extends dynamic.Resource {
    public readonly password!: pulumi.Output<string>;
    public readonly username!: pulumi.Output<string>;

    constructor(name: string, args: BootstrapAdminPasswordArgs, opts?: pulumi.ComponentResourceOptions) {
        super(new BootstrapAdminPasswordProvider(), name, {...args, username: undefined, password: undefined }, { ...opts, additionalSecretOutputs: ["password"] });
    }
}
