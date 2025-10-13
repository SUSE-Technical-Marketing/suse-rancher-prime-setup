import got from "got";
import https from "https";

export interface RancherLoginArgs {
    rancherServer: string; // URL of the Rancher server
    username?: string; // Username for Rancher login
    password?: string; // Password for Rancher login
    token?: string; // Bearer token for Rancher login
    insecure?: boolean; // Whether to skip TLS verification (default: false)
    retryLimit?: number; // Number of retry attempts for login (default: 2)
}

export async function loginToRancher(args: RancherLoginArgs): Promise<string> {
    if (args.token) {
        console.log(`Using provided token to authenticate to Rancher at ${args.rancherServer}`);
        return args.token;
    }

    if (!args.username || !args.password) {
        throw new Error("Either token or username and password must be provided for Rancher login.");
    }


    const url = `${args.rancherServer}/v3-public/localProviders/local?action=login`;
    console.log(`Logging in to Rancher at ${url} with username ${args.username}`);

    const agent = new https.Agent({
        rejectUnauthorized: !args.insecure, // Skip TLS verification if insecure is true
    });

    const res: any = await got.post(url, {
        agent: { https: agent },
        json: {
            username: args.username,
            password: args.password,
        },
        responseType: "json",
        timeout: { request: 10000 },
        
        retry: { limit: args.retryLimit ?? 2, calculateDelay: () => 5000 }
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
    }

    const token = res.body?.["token"];
    return token;
}
