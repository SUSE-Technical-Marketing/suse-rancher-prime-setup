/** A SUSE Observability instance: its URL, and whether to skip checking its certificate (Let's Encrypt staging). */
export interface ObservabilityEndpoint {
    url: string;
    insecure: boolean;
}

/** A request body sent as it is, with its content type. */
export class RawBody {
    constructor(readonly data: Uint8Array, readonly contentType: string) {}
}

/** A file as a multipart/form-data body, in the form field `field` (`sts stackpack upload`: `stackPack`). */
export function multipartFile(field: string, filename: string, data: Uint8Array): RawBody {
    const boundary = `lab-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const head = `--${boundary}\r\ncontent-disposition: form-data; name="${field}"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`;
    return new RawBody(Buffer.concat([Buffer.from(head), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)]), `multipart/form-data; boundary=${boundary}`);
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
        // A body as it is (a multipart upload), or JSON.
        const raw = body instanceof RawBody ? body : undefined;
        const payload = raw ? raw.data : body === undefined ? undefined : JSON.stringify(body);
        const req = client.request(`${endpoint.url.replace(/\/+$/, "")}/api${path}`, {
            method,
            headers: {
                "x-api-key": token,
                accept: "application/json",
                ...(payload ? { "content-type": raw ? raw.contentType : "application/json", "content-length": Buffer.byteLength(payload) } : {}),
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
