import { Agent, fetch } from "undici";

export interface HarvesterLogin {
    url: string;
    username: string;
    password: string;
    /** Skip TLS verification; Harvester ships a self-signed certificate. */
    insecure: boolean;
    /** Token lifetime; long enough for a whole `up` when the token also drives Pulumi. */
    ttlMs?: number;
}

export interface ApiResponse<T = any> {
    status: number;
    body: T;
}

/** The oldest Harvester release the lab engine supports. */
export const MIN_HARVESTER_VERSION = { major: 1, minor: 8 };

/**
 * Minimal client for a Harvester cluster's API: Rancher-style login, then plain Kubernetes calls
 * through the embedded proxy at `/k8s/clusters/local`. Never logs credentials or tokens.
 */
export class HarvesterApi {
    private constructor(
        readonly url: string,
        private readonly token: string,
        private readonly dispatcher: Agent,
        readonly insecure: boolean,
    ) {}

    /** A kubeconfig entry for this session: the Kubernetes API through the embedded proxy. */
    kubeconfigEntry(name: string) {
        return {
            cluster: { name, cluster: { server: `${this.url}/k8s/clusters/local`, "insecure-skip-tls-verify": this.insecure } },
            user: { name, user: { token: this.token } },
            context: { name, context: { cluster: name, user: name } },
        };
    }

    static async login(args: HarvesterLogin): Promise<HarvesterApi> {
        const url = args.url.replace(/\/+$/, "");
        const dispatcher = new Agent({ connect: { rejectUnauthorized: !args.insecure } });
        let response;
        try {
            response = await fetch(`${url}/v3-public/localProviders/local?action=login`, {
                method: "POST",
                dispatcher,
                headers: { "content-type": "application/json" },
                // Short-lived token: the CLI only needs it for this run.
                body: JSON.stringify({ username: args.username, password: args.password, responseType: "json", ttl: args.ttlMs ?? 3_600_000, description: "lab CLI" }),
            });
        } catch (e) {
            throw new Error(`can't reach Harvester at ${url}: ${describeFetchError(e, args.insecure)}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`Harvester at ${url} rejected the login for user "${args.username}"; check the credentials`);
        }
        if (!response.ok) {
            throw new Error(`login to Harvester at ${url} failed: HTTP ${response.status}`);
        }
        const body = await response.json() as { token?: string };
        if (!body.token) throw new Error(`login to Harvester at ${url} returned no token`);
        return new HarvesterApi(url, body.token, dispatcher, args.insecure);
    }

    /** A Kubernetes API call, e.g. `k8s("GET", "/api/v1/namespaces/default/configmaps/x")`. */
    async k8s<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
        const response = await fetch(`${this.url}/k8s/clusters/local${path}`, {
            method,
            dispatcher: this.dispatcher,
            headers: {
                authorization: `Bearer ${this.token}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            // keep the raw text
        }
        return { status: response.status, body: parsed as T };
    }

    /** The Harvester release, from the `server-version` setting (e.g. `v1.9.0`). */
    async serverVersion(): Promise<string | undefined> {
        const res = await this.k8s<{ value?: string; default?: string }>("GET", "/apis/harvesterhci.io/v1beta1/settings/server-version");
        if (res.status !== 200) return undefined;
        return res.body.value || res.body.default || undefined;
    }

    /** Best effort: drop the login token so it doesn't linger until its TTL expires. */
    async logout(): Promise<void> {
        try {
            await fetch(`${this.url}/v3/tokens?action=logout`, {
                method: "POST",
                dispatcher: this.dispatcher,
                headers: { authorization: `Bearer ${this.token}` },
            });
        } catch {
            // ignore
        } finally {
            await this.dispatcher.close();
        }
    }
}

/**
 * Compare a Harvester version string with the minimum. Returns undefined for versions that
 * can't be parsed (development builds), so callers can warn instead of failing.
 */
export function isSupportedHarvesterVersion(version: string): boolean | undefined {
    const match = /^v?(\d+)\.(\d+)/.exec(version);
    if (!match) return undefined;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > MIN_HARVESTER_VERSION.major || (major === MIN_HARVESTER_VERSION.major && minor >= MIN_HARVESTER_VERSION.minor);
}

function describeFetchError(e: unknown, insecure: boolean): string {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code ?? "";
    if (code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
        return `TLS certificate not trusted (${code})${insecure ? "" : "; set insecure: true for this harvester if it uses Harvester's self-signed certificate"}`;
    }
    return cause?.message ?? (e as Error).message;
}
