/** Where a Rancher server is; `insecure` for Let's Encrypt staging certificates. */
export interface RancherEndpoint {
    url: string;
    insecure: boolean;
}

/**
 * Calls to Rancher's own API (login, password change, app installs). Self-contained like
 * kubeRequest, because dynamic providers are serialized into the Pulumi state.
 */
export function rancherRequest(endpoint: RancherEndpoint, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }> {
    const https = require("node:https");
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = https.request(`${endpoint.url.replace(/\/+$/, "")}${path}`, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(payload ? { "content-type": "application/json" } : {}),
            },
            rejectUnauthorized: !endpoint.insecure,
            timeout: 30000,
        }, (res: any) => {
            let text = "";
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => {
                let parsed: unknown = text;
                try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on("timeout", () => req.destroy(new Error("request timed out")));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** Log in as a local user; returns a token, or undefined when the credentials are rejected. */
export async function rancherLogin(endpoint: RancherEndpoint, username: string, password: string): Promise<string | undefined> {
    const res = await rancherRequest(endpoint, "POST", "/v3-public/localProviders/local?action=login", {
        username, password, responseType: "json", ttl: 3_600_000, description: "lab",
    });
    if (res.status === 401 || res.status === 403) return undefined;
    if (res.status < 200 || res.status >= 300) throw new Error(`Rancher login failed: HTTP ${res.status}`);
    return res.body?.token;
}
