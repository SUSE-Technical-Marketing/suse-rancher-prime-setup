import * as pulumi from "@pulumi/pulumi";
import { kubeRequest, poll, rancherLogin, rancherRequest } from "@lab/kube";

interface Inputs {
    kubeconfig: string;
    url: string;
    insecure: boolean;
    password: string;
    timeoutSeconds: number;
}

/**
 * Set the admin password of a fresh Rancher: read the generated bootstrap password from the
 * `bootstrap-secret`, log in with it, change it. Idempotent: if the admin password already works,
 * there is nothing to do.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const endpoint = { url: inputs.url, insecure: inputs.insecure };
        await poll(async seen => {
            try {
                if (await rancherLogin(endpoint, "admin", inputs.password)) return true;
                const secret = await kubeRequest({ kubeconfig: inputs.kubeconfig }, "GET", "/api/v1/namespaces/cattle-system/secrets/bootstrap-secret");
                const encoded = secret.body?.data?.bootstrapPassword;
                if (secret.status === 200 && encoded) {
                    const bootstrap = Buffer.from(encoded, "base64").toString("utf8");
                    const token = await rancherLogin(endpoint, "admin", bootstrap);
                    if (token) {
                        const res = await rancherRequest(endpoint, "POST", "/v3/users?action=changepassword", { currentPassword: bootstrap, newPassword: inputs.password }, token);
                        if (res.status >= 200 && res.status < 300) seen("password changed; logging in with it");
                        else seen(`changing the password failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
                    } else {
                        seen("neither the admin password nor the bootstrap password is accepted");
                    }
                } else {
                    seen("bootstrap secret not there yet");
                }
            } catch (e) {
                seen((e as Error).message); // Rancher not answering yet
            }
            return undefined;
        }, { timeoutSeconds: inputs.timeoutSeconds, everyMs: 10000, failure: last => `setting the Rancher admin password at ${inputs.url} timed out: ${last}` });
        return { id: `${inputs.url}#admin`, outs: inputs };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        const changes = olds.url !== news.url || olds.password !== news.password;
        return { changes, replaces: changes ? ["url"] : [] };
    },
    async delete() {
        // Rancher goes with the lab.
    },
};

export interface RancherBootstrapArgs {
    kubeconfig: pulumi.Input<string>;
    url: pulumi.Input<string>;
    insecure: boolean;
    password: pulumi.Input<string>;
    timeoutSeconds: number;
}

export class RancherBootstrap extends pulumi.dynamic.Resource {
    constructor(name: string, args: RancherBootstrapArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig), password: pulumi.secret(args.password) }, opts, "lab", "RancherBootstrap");
    }
}
