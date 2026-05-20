import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { waitFor, RancherClient } from "@suse-tmm/common";
import { loginToRancher } from "@suse-tmm/common";

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

        const start = Date.now();

        // Fetch the bootstrap token from the Rancher API
        return waitFor(() => this.fetchBootstrapToken(inputs.kubeconfig), {
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
        pulumi.log.info(`[Bootstrap] POST ${server}/v3/users?action=changepassword (changepassword for "${username}")`);
        const client = new RancherClient({ server, token, insecure: insecure ?? false });
        await client.post("v3/users", { currentPassword: password, newPassword }, { action: "changepassword" });
        pulumi.log.info(`[Bootstrap] Password update complete.`);
    }

    async fetchBootstrapToken(kubeconfig: string): Promise<string | undefined> {
        const client = await RancherClient.fromKubeconfig(kubeconfig);
        pulumi.log.info(`[Bootstrap] GET api/v1/namespaces/cattle-system/secrets/bootstrap-secret`);
        return client.get("api/v1/namespaces/cattle-system/secrets/bootstrap-secret")
            .then(body => {
                const bootstrapToken = body?.data?.["bootstrapPassword"];
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
