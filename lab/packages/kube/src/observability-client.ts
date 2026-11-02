/** A SUSE Observability instance: its URL, and whether to skip checking its certificate (Let's Encrypt staging). */
export interface ObservabilityEndpoint {
    url: string;
    insecure: boolean;
}

/**
 * Calls to SUSE Observability's API (`/api/...`), authenticated with a service token in X-API-Key,
 * as its CLI does. Self-contained like kubeRequest, because dynamic providers are serialized into
 * the Pulumi state.
 */
export function observabilityRequest(endpoint: ObservabilityEndpoint, token: string, method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<{ status: number; body: any }> {
    // http: only for a local test server.
    const client = require(endpoint.url.startsWith("http:") ? "node:http" : "node:https");
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = client.request(`${endpoint.url.replace(/\/+$/, "")}/api${path}`, {
            method,
            headers: {
                "x-api-key": token,
                accept: "application/json",
                ...(payload ? { "content-type": "application/json" } : {}),
            },
            rejectUnauthorized: !endpoint.insecure,
            timeout: timeoutMs,
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
