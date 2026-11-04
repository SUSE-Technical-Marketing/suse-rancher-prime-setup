import * as pulumi from "@pulumi/pulumi";
import { kubeRequest, poll, rancherLogin, rancherRequest } from "@lab/kube";

interface Inputs {
    kubeconfig: string;
    url: string;
    insecure: boolean;
    password: string;
    /** The Rancher host's own address: where Rancher answers when its name doesn't lead there. */
    hostAddress?: string;
    timeoutSeconds: number;
}

/** How long a wrong name (while Rancher answers at its host) is waited out: a DNS record that's just been made. */
const WRONG_NAME_SECONDS = 180;

/**
 * Why Rancher can't be reached by its URL's name, when that's the name: it doesn't resolve, or it
 * resolves elsewhere while Rancher answers at the host's own address (asked by its name). `sure`:
 * Rancher answers at the host, so waiting can't help, only a DNS record. Undefined when the name
 * isn't to blame (or it can't tell: Rancher behind a load balancer or tunnel answers elsewhere).
 */
export async function nameProblem(url: string, hostAddress: string | undefined, port = 443): Promise<{ message: string; sure: boolean } | undefined> {
    const dns = require("node:dns").promises;
    const https = require("node:https");
    const name = new URL(url).hostname;
    const addresses = async (host: string): Promise<string[]> => {
        if (/^[\d.]+$|:/.test(host)) return [host];
        return (await dns.lookup(host, { all: true }).catch(() => [])).map((a: { address: string }) => a.address);
    };
    // Rancher by its name, at the host: through the host's ingress, as a browser would with the right record.
    const answersAtHost = (address: string) => new Promise<boolean>(resolve => {
        const req = https.request({ host: address, port, path: "/ping", servername: name, headers: { host: name }, rejectUnauthorized: false, timeout: 10000 },
            (res: any) => { res.resume(); resolve(res.statusCode === 200); });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
        req.end();
    });
    const resolved = await addresses(name);
    const host = hostAddress ? await addresses(hostAddress) : [];
    const atHost = host.length > 0 && await answersAtHost(host[0]);
    const fix = `give ${name} a DNS record for ${host[0] ?? "the Rancher host"} (the Harvester's harvester-dns-controller profile makes them, or your own DNS)`;
    if (resolved.length === 0) return { message: `${name} doesn't resolve: ${fix}`, sure: atHost };
    if (atHost && !resolved.some(a => host.includes(a))) {
        return { message: `${name} resolves to ${resolved.join(", ")}, but Rancher answers at its host ${host[0]}: ${fix}`, sure: true };
    }
    return undefined;
}

/**
 * Set the admin password of a fresh Rancher: read the generated bootstrap password from the
 * `bootstrap-secret`, log in with it, change it. Idempotent: if the admin password already works,
 * there is nothing to do.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const endpoint = { url: inputs.url, insecure: inputs.insecure };
        let wrongSince: number | undefined;
        await poll(async seen => {
            // Rancher by its name first: when that fails, the name may be why.
            const byName = await rancherRequest(endpoint, "GET", "/ping").then(r => r.status === 200, () => false);
            if (!byName) {
                const problem = await nameProblem(inputs.url, inputs.hostAddress);
                if (problem?.sure) {
                    wrongSince ??= Date.now();
                    if (Date.now() - wrongSince >= WRONG_NAME_SECONDS * 1000) throw new Error(`Rancher is up, but the lab can't reach it at ${inputs.url}: ${problem.message}`);
                } else {
                    wrongSince = undefined;
                }
                seen(problem ? problem.message : `Rancher doesn't answer at ${inputs.url} yet`);
                return undefined;
            }
            wrongSince = undefined;
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
    /** The Rancher host's address: to tell when its name, not Rancher, is the problem. */
    hostAddress?: pulumi.Input<string>;
    timeoutSeconds: number;
}

export class RancherBootstrap extends pulumi.dynamic.Resource {
    constructor(name: string, args: RancherBootstrapArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig), password: pulumi.secret(args.password) }, opts, "lab", "RancherBootstrap");
    }
}
