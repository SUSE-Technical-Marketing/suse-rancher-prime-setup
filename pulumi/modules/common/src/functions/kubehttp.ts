import https from 'https';
import { load } from 'js-yaml';

export interface KubeConfigHttpOutput {
    agent: https.Agent;
    headers: Record<string, string>;
    server: string;
}

export function kubeConfigToHttp(kubeconfig: string): KubeConfigHttpOutput {
    const kc: any = load(kubeconfig);
    const currCtx: string = kc["current-context"] ?? kc.contexts[0].name;
    const ctx: any = kc.contexts.find((c: any) => c.name === currCtx).context;

    const cluster: any = kc.clusters.find((c: any) => c.name === ctx.cluster).cluster;
    const server = cluster.server.replace(/\/$/, "");
    const insecure = cluster["insecure-skip-tls-verify"] === true;
    const ca = readBase64Property(cluster, "certificate-authority-data");

    const user: any = kc.users.find((u: any) => u.name === ctx.user).user;
    const cert = readBase64Property(user, "client-certificate-data");
    const key = readBase64Property(user, "client-key-data");

    // token takes precedence over basic auth
    const token = user.token
        || user["auth-provider"]?.config?.["access-token"];
    const basicUser = user.username;
    const basicPass = user.password;

    // 3️⃣  build HTTPS agent + headers -----------------------------------------
    const agent = new https.Agent({
        ca,
        cert,
        key,
        rejectUnauthorized: !insecure,
    });

    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    } else if (basicUser && basicPass) {
        const creds = Buffer.from(`${basicUser}:${basicPass}`).toString("base64");
        headers["Authorization"] = `Basic ${creds}`;
    }

    return {
        agent,
        headers,
        server,
    };
}

function readBase64Property(obj: any, prop: string): Buffer | undefined {
    return obj[prop] ? Buffer.from(obj[prop], "base64") : undefined;
}
