/**
 * Which cluster a dynamic provider talks to:
 * - `{ context }`: a Harvester, through the kubeconfig the lab CLI writes for every run
 *   (`$KUBECONFIG`, JSON), so its credentials never become resource inputs;
 * - `{ kubeconfig }`: a lab cluster's own kubeconfig as JSON (secret input, e.g. a k3s host).
 */
export type KubeTarget = { context: string; harvesterApi?: boolean } | { kubeconfig: string };

/**
 * Kubernetes calls for dynamic providers. Dynamic providers are serialized into the Pulumi state,
 * so this is self-contained: Node built-ins only, loaded inside the function.
 */
export function kubeRequest(target: KubeTarget, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const fs = require("node:fs");
    const https = require("node:https");

    let config: any;
    let contextName: string;
    if ("context" in target) {
        const file = process.env.KUBECONFIG;
        if (!file) throw new Error("KUBECONFIG is not set; run this through the lab CLI");
        config = JSON.parse(fs.readFileSync(file, "utf8"));
        contextName = target.context;
    } else {
        config = JSON.parse(target.kubeconfig);
        contextName = config["current-context"];
    }
    const ctx = config.contexts.find((c: any) => c.name === contextName)?.context;
    if (!ctx) throw new Error(`no context "${contextName}" in the kubeconfig`);
    const cluster = config.clusters.find((c: any) => c.name === ctx.cluster).cluster;
    const user = config.users.find((u: any) => u.name === ctx.user).user;
    const b64 = (v: string | undefined) => (v ? Buffer.from(v, "base64") : undefined);

    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        // Harvester's own API (`/v1/harvester/...`) sits next to the Kubernetes proxy, not under it.
        const base = "harvesterApi" in target && target.harvesterApi ? cluster.server.replace(/\/k8s\/clusters\/local\/?$/, "") : cluster.server;
        const req = https.request(`${base}${path}`, {
            method,
            headers: {
                ...(user.token ? { authorization: `Bearer ${user.token}` } : {}),
                ...(payload ? { "content-type": method === "PATCH" ? "application/merge-patch+json" : "application/json" } : {}),
            },
            ca: b64(cluster["certificate-authority-data"]),
            cert: b64(user["client-certificate-data"]),
            key: b64(user["client-key-data"]),
            rejectUnauthorized: !cluster["insecure-skip-tls-verify"],
        }, (res: any) => {
            let text = "";
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => {
                let parsed: unknown = text;
                try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}
