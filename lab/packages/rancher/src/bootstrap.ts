import * as pulumi from "@pulumi/pulumi";
import { kubeRequest, rancherLogin, rancherRequest } from "@lab/kube";

interface Inputs {
    kubeconfig: string;
    url: string;
    insecure: boolean;
    password: string;
}

/**
 * Set the admin password of a fresh Rancher: read the generated bootstrap password from the
 * `bootstrap-secret`, log in with it, change it. Idempotent: if the admin password already works,
 * there is nothing to do.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const endpoint = { url: inputs.url, insecure: inputs.insecure };
        const deadline = Date.now() + 15 * 60 * 1000;
        let last = "";
        while (Date.now() < deadline) {
            try {
                if (await rancherLogin(endpoint, "admin", inputs.password)) {
                    return { id: `${inputs.url}#admin`, outs: inputs };
                }
                const secret = await kubeRequest({ kubeconfig: inputs.kubeconfig }, "GET", "/api/v1/namespaces/cattle-system/secrets/bootstrap-secret");
                const encoded = secret.body?.data?.bootstrapPassword;
                if (secret.status === 200 && encoded) {
                    const bootstrap = Buffer.from(encoded, "base64").toString("utf8");
                    const token = await rancherLogin(endpoint, "admin", bootstrap);
                    if (token) {
                        const res = await rancherRequest(endpoint, "POST", "/v3/users?action=changepassword", { currentPassword: bootstrap, newPassword: inputs.password }, token);
                        if (res.status >= 200 && res.status < 300) continue; // verified by the login at the top
                        last = `changing the password failed: HTTP ${res.status} ${JSON.stringify(res.body)}`;
                    } else {
                        last = "neither the admin password nor the bootstrap password is accepted";
                    }
                } else {
                    last = "bootstrap secret not there yet";
                }
            } catch (e) {
                last = (e as Error).message; // Rancher not answering yet
            }
            await new Promise(r => setTimeout(r, 10000));
        }
        throw new Error(`setting the Rancher admin password at ${inputs.url} timed out: ${last}`);
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
}

export class RancherBootstrap extends pulumi.dynamic.Resource {
    constructor(name: string, args: RancherBootstrapArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig), password: pulumi.secret(args.password) }, opts, "lab", "RancherBootstrap");
    }
}
