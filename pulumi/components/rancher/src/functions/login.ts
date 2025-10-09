import got from "got";

export interface RancherLoginArgs {
    rancherServer: string; // URL of the Rancher server
    username: string; // Username for Rancher login
    password: string; // Password for Rancher login
    insecure?: boolean; // Whether to skip TLS verification (e.g., when using staging certs)
}

export async function loginToRancher(args: RancherLoginArgs): Promise<string> {
    const url = `${args.rancherServer}/v3-public/localProviders/local?action=login`;
    console.log(`Logging in to Rancher at ${url} with username ${args.username}`);
    const res: any = await got.post(url, {
        json: {
            username: args.username,
            password: args.password,
        },
        responseType: "json",
        timeout: { request: 10000 },
        retry: { limit: 5, calculateDelay: () => 5000 },
        https: {
            rejectUnauthorized: !args.insecure,
        },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
    }

    const token = res.body?.["token"];
    return token;
}
