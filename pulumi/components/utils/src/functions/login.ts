import got from "got";

export interface RancherLoginArgs {
    server: string; // URL of the Rancher server
    username?: string; // Username for Rancher login
    password?: string; // Password for Rancher login
    token?: string; // Bearer token for Rancher login
    insecure?: boolean; // Whether to skip TLS verification (default: false)
    retryLimit?: number; // Number of retry attempts for login (default: 2)
}

export async function loginToRancher(args: RancherLoginArgs): Promise<string> {
    if (args.token) {
        console.log(`Using provided token to authenticate to Rancher at ${args.server}`);
        return args.token;
    }

    if (!args.username || !args.password) {
        throw new Error("Either token or username and password must be provided for Rancher login.");
    }


    const url = `${args.server}/v3-public/localProviders/local?action=login`;
    console.log(`Logging in to Rancher at ${url} with username ${args.username}, password: ${args.password}, token: ${args.token}`);

    return got.post<{token: string}>(url, {
        https: {
            rejectUnauthorized: !args.insecure, // Skip TLS verification if insecure is true
        },
        json: {
            username: args.username,
            password: args.password,
        },
        responseType: "json",
        timeout: { request: 10000 },
        
        retry: { limit: 2, calculateDelay: () => 5000 }
    }).then(res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
        }
        return res;
    }).then(async res => {
        const token = res.body?.token;
        console.log(`Successfully logged in to Rancher, received token: ${token?.substring(0, 8)}...${token?.substring(token.length - 4)}`);
        return token;
    }).catch(err => {
        console.error(`Error logging in to Rancher: ${err.message}`);
        throw new Error(`Error logging in to Rancher: ${err.message}`);
    });
}
