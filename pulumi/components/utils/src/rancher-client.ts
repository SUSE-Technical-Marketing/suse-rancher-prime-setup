import {got, Got, Response}  from "got";
import { kubeConfigToHttp } from "./functions/kubehttp";

export interface RancherServerConnectionArgs {
    server: string; // URL of the Rancher server
    username?: string; // Username for Rancher login
    password?: string; // Password for Rancher login
    authToken?: string; // Bearer token for Rancher login
    insecure?: boolean; // Whether to skip TLS verification (default: false)
    retryLimit?: number; // Number of retry attempts for login (default: 2)
    retryDelayMs?: number; // Delay between retry attempts in milliseconds (default: 5000)
}

export interface RancherKubeConfigConnectionDetails {
    kubeconfig: string;
    server: string;
    insecure: boolean;
}

export interface RancherServerConnectionDetails {
    server: string;
    token: string;
    insecure: boolean;
}

export type RancherConnectionDetails = RancherKubeConfigConnectionDetails | RancherServerConnectionDetails;

export class RancherClient {
    public readonly details: RancherConnectionDetails;

    constructor(connectionDetails: RancherConnectionDetails) {
        this.details = connectionDetails;
    }

    private rancherGot(): Got {
        if ("kubeconfig" in this.details) {
            return this.buildGotFromKubeconfig(this.details.kubeconfig);
        } else {
            return this.buildGotFromUrl(this.details.server, this.details.token, this.details.insecure);
        }
    }

    private static checkStatusCode(method: string): (resp: Response<{ [key: string]: any }>) => { [key: string]: any } {
        return (response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to ${method} ${response.url}: ${response.statusCode} ${JSON.stringify(response.body)}`);
            }
            return response.body;
        };
    }


    private buildGotFromKubeconfig(kubeconfig: string): Got {
        const outputs = kubeConfigToHttp(kubeconfig);

        return got.extend({
            prefixUrl: outputs.server.replace(/\/$/, ""),
            agent: { https: outputs.agent },
            headers: outputs.headers,
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });
    }

    private buildGotFromUrl(url: string, token: string, insecure: boolean): Got {
        console.log(`Building Got instance for URL: ${url} with token: ${token} and insecure: ${insecure}`);
        return got.extend({
            prefixUrl: url.replace(/\/$/, ""),
            https: {
                rejectUnauthorized: !insecure,
            },
            headers: {
                Authorization: `Bearer ${token}`,
            },
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });
    }

    static async login(args: RancherServerConnectionArgs): Promise<RancherClient> {
        const url = `${args.server}/v3-public/localProviders/local?action=login`;
        const retryLimit = args.retryLimit ?? 2;
        const retryDelay = args.retryDelayMs ?? 5000;

        console.log(`[RancherLogin] POST ${url} as "${args.username} / ${args.password}" (retries: ${retryLimit}, retryDelay: ${retryDelay}ms, insecure: ${args.insecure ?? false})`);

        return got.post<{ token: string }>(url, {
            https: {
                rejectUnauthorized: !args.insecure,
            },
            responseType: "json",
            timeout: {
                lookup: 5000,
                connect: 5000,
                secureConnect: 5000,
                socket: 10000,
                send: 10000,
                response: 15000,
                request: 30000,
            },
            retry: {
                limit: retryLimit,
                calculateDelay: ({attemptCount}) => {
                    if (attemptCount > retryLimit) {
                        console.log(`[RancherLogin] Retry limit reached (${retryLimit}), giving up.`);
                        return 0;
                    }
                    console.log(`[RancherLogin] Retry attempt ${attemptCount}/${retryLimit} in ${retryDelay}ms...`);
                    return retryDelay;
                },
            },
            hooks: {
                beforeRequest: [
                    options => {
                        console.log(`[RancherLogin] Sending request to ${options.url} ...`);
                    },
                ],
                beforeError: [
                    error => {
                        console.error(`[RancherLogin] Request error: code=${error.code ?? 'N/A'} message="${error.message}"`);
                        return error;
                    },
                ],
                beforeRetry: [
                    (error, retryCount) => {
                        console.warn(`[RancherLogin] Request failed (attempt ${retryCount}): code=${error.code ?? 'N/A'} message="${error.message}"`);
                    },
                ],
            },
            json: {
                username: args.username,
                password: args.password,
            },
        }).then((response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to login to Rancher at ${args.server}: ${response.statusCode} ${JSON.stringify(response.body)}`);
            }
            const token = response.body.token;
            console.log(`[RancherLogin] Login successful, received token: ${token?.substring(0, 8)}...`);
            return new RancherClient({ server: args.server, token, insecure: args.insecure ?? false });
        }).catch(err => {
            console.error(`[RancherLogin] Login failed for server "${args.server}" user "${args.username}": ${err.message}`);
            if (err.code) console.error(`[RancherLogin] Error code: ${err.code}`);
            if (err.timings) console.error(`[RancherLogin] Timings: ${JSON.stringify(err.timings)}`);
            throw err;
        });
    }

    async get(path: string, searchParams?: { [key: string]: any }): Promise<{ [key: string]: any }> {
        path = path.replace(/^\/+/, ""); // Remove leading slashes
        return this.rancherGot().get<{ [key: string]: any }>(path, {
            searchParams: searchParams ? {
                ...searchParams,
            } : undefined,
        }).then(RancherClient.checkStatusCode("GET"));
    }

    async post(path: string, body: any, searchParams?: { [key: string]: any }): Promise<{ [key: string]: any }> {
        path = path.replace(/^\/+/, ""); // Remove leading slashes
        console.log(`Posting to Rancher path: ${path} with body: ${JSON.stringify(body)}`);
        return this.rancherGot().post<{ [key: string]: any }>(path, {
            searchParams: searchParams ? {
                ...searchParams,
            } : undefined,
            json: body,
        }).catch((error) => {
            console.error(`Error occurred while posting to ${path}: ${error.message}`);
            console.error(`Error contents: ${JSON.stringify(error.response?.body)}`);
            throw error;
        }).then(RancherClient.checkStatusCode("POST"));
    }

    async patch(path: string, body: any): Promise<{ [key: string]: any }> {
        path = path.replace(/^\/+/, ""); // Remove leading slashes
        return this.rancherGot().patch<{ [key: string]: any }>(path, {
            json: body,
            headers: {
                "Content-Type": "application/json-patch+json",
            },
        }).catch((error) => {
            console.error(`Error occurred while PATCH-ing ${path}: ${error.message}`);
            console.error(`Error contents: ${JSON.stringify(error.response?.body)}`);
            throw error;
        }).then(RancherClient.checkStatusCode("PATCH"));
    }

    async put(path: string, body: any): Promise<{ [key: string]: any }> {
        path = path.replace(/^\/+/, ""); // Remove leading slashes
        return this.rancherGot().put<{ [key: string]: any }>(path, {
            json: body,
        }).then(RancherClient.checkStatusCode("PUT"));
    }

    static async fromKubeconfig(kubeconfig: string): Promise<RancherClient> {
        const outputs = kubeConfigToHttp(kubeconfig); // Read to extract server and security settings
        return Promise.resolve(new RancherClient({ server: outputs.server, kubeconfig, insecure: !outputs.agent.options.rejectUnauthorized }));
    }

    static async fromServerConnectionArgs(args: RancherServerConnectionArgs): Promise<RancherClient> {
        console.log(`[RancherClient] fromServerConnectionArgs: server="${args.server}" user="${args.username}" hasToken=${!!args.authToken}`);
        if (args.authToken) {
            return Promise.resolve(new RancherClient({ server: args.server, token: args.authToken, insecure: args.insecure ?? false }));
        } else if (args.username && args.password) {
            return RancherClient.login(args);
        } else {
            return Promise.reject(new Error("Either token or username and password must be provided"));
        }
    }

    static async fromUrl(server: string, username?: string, password?: string, authToken?: string, insecure: boolean = false): Promise<RancherClient> {
        return RancherClient.fromServerConnectionArgs({ server, username, password, authToken: authToken, insecure });
    }
}