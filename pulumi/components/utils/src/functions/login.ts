import got from "got";
import https from "https";

export interface RancherLoginArgs {
    rancherServer: string; // URL of the Rancher server
    username: string; // Username for Rancher login
    password: string; // Password for Rancher login
    insecure?: boolean; // Whether to skip TLS verification (default: false)
}

export async function loginToRancher(args: RancherLoginArgs): Promise<string> {
    const url = `${args.rancherServer}/v3-public/localProviders/local?action=login`;
    console.log(`Logging in to Rancher at ${url} with username ${args.username} / ${args.password}`);

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
        
        retry: { limit: 2, calculateDelay: () => 5000 }
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
    }

    const token = res.body?.["token"];
    return token;
}
