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
        console.log(`[loginToRancher] Using provided token for ${args.server}`);
        return args.token;
    }

    if (!args.username || !args.password) {
        throw new Error("Either token or username and password must be provided for Rancher login.");
    }

    const url = `${args.server}/v3-public/localProviders/local?action=login`;
    const retryLimit = args.retryLimit ?? 2;

    console.log(`[loginToRancher] POST ${url} as "${args.username}" (retries: ${retryLimit}, insecure: ${args.insecure ?? false})`);

    return got.post<{[key: string]: any}>(url, {
        https: {
            rejectUnauthorized: !args.insecure,
        },
        json: {
            username: args.username,
            password: args.password,
        },
        responseType: "json",
        timeout: {
            lookup: 5000,
            connect: 5000,
            secureConnect: 5000,
            request: 30000,
        },
        retry: {
            limit: retryLimit,
            calculateDelay: ({ attemptCount }) => {
                if (attemptCount > retryLimit) {
                    console.log(`[loginToRancher] Retry limit reached (${retryLimit}), giving up.`);
                    return 0;
                }
                console.log(`[loginToRancher] Retry ${attemptCount}/${retryLimit} in 5s...`);
                return 5000;
            },
        },
        hooks: {
            beforeRequest: [
                options => { console.log(`[loginToRancher] Sending request to ${options.url}`); },
            ],
            beforeError: [
                error => {
                    console.error(`[loginToRancher] Error: code=${error.code ?? 'N/A'} message="${error.message}"`);
                    return error;
                },
            ],
        },
    }).then(res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Failed to login to Rancher: ${res.statusCode} ${res.statusMessage}`);
        }
        const token = res.body?.token;
        console.log(`[loginToRancher] Success, token: ${token?.substring(0, 8)}...`);
        return token;
    }).catch(err => {
        console.error(`[loginToRancher] Failed for server "${args.server}" user "${args.username}": ${err.message}`);
        if (err.code) console.error(`[loginToRancher] Error code: ${err.code}`);
        throw err;
    });
}
