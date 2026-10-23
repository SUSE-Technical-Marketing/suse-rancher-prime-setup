import * as fs from "node:fs";
import * as path from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { cert_manager } from "@lab/crds";
import { ClusterAccess, helmApp, onCluster } from "@lab/kubernetes";

export type AcmeIssuer = "letsencrypt-prod" | "letsencrypt-staging";

export interface CertManagerArgs {
    cluster: ClusterAccess;
    version: string;
    email: string;
    cloudflareToken: pulumi.Input<string>;
    /** Issuer for the wildcard certificate. */
    issuer: AcmeIssuer;
    /** `<host>.<domain>`; the certificate covers it and `*.<host>.<domain>`. */
    wildcardDomain: string;
}

const ISSUERS: Record<AcmeIssuer, string> = {
    "letsencrypt-prod": "https://acme-v02.api.letsencrypt.org/directory",
    "letsencrypt-staging": "https://acme-staging-v02.api.letsencrypt.org/directory",
};

/**
 * The Let's Encrypt staging roots (PEM). Nothing trusts them by default, so a server with a
 * staging certificate hands them to its clients as a private CA (Rancher's agents).
 */
export const LETSENCRYPT_STAGING_ROOTS = fs.readFileSync(path.join(__dirname, "..", "certs", "letsencrypt-staging-roots.pem"), "utf8")
    .split("\n").filter(line => !line.startsWith("#")).join("\n");

/** Name of the wildcard certificate's secret; Sprouter copies it into every namespace. */
export const WILDCARD_SECRET = "wildcard-cert";

/**
 * cert-manager with Let's Encrypt issuers (Cloudflare DNS-01) and the host's wildcard certificate.
 * The secret is labelled for Sprouter, which makes it available to ingresses in every namespace.
 */
export class CertManager extends pulumi.ComponentResource {
    readonly secretName = WILDCARD_SECRET;
    readonly certificate: cert_manager.v1.Certificate;

    constructor(name: string, args: CertManagerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:CertManager", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const ns = "cert-manager";

        const chart = helmApp(`${name}/chart`, {
            chart: "cert-manager",
            repo: "https://charts.jetstack.io",
            version: args.version,
            namespace: ns,
            values: {
                crds: { enabled: true },
                // Lab names usually resolve internally too; check the challenge record publicly.
                dns01RecursiveNameserversOnly: true,
                dns01RecursiveNameservers: "8.8.8.8:53,1.1.1.1:53",
            },
        }, o);

        const token = new k8s.core.v1.Secret(`${name}/cloudflare-token`, {
            metadata: { name: "cloudflare-api-token", namespace: ns },
            stringData: { "api-token": pulumi.secret(args.cloudflareToken) },
        }, { ...o, dependsOn: [chart] });

        const issuers = Object.entries(ISSUERS).map(([issuer, server]) => new cert_manager.v1.ClusterIssuer(`${name}/${issuer}`, {
            metadata: { name: issuer },
            spec: {
                acme: {
                    server,
                    email: args.email,
                    privateKeySecretRef: { name: issuer },
                    solvers: [{ dns01: { cloudflare: { apiTokenSecretRef: { name: token.metadata.name, key: "api-token" } } } }],
                },
            },
        }, { ...o, dependsOn: [chart, token] }));

        this.certificate = new cert_manager.v1.Certificate(`${name}/wildcard`, {
            metadata: {
                name: WILDCARD_SECRET,
                namespace: ns,
                annotations: { "pulumi.com/waitFor": "condition=Ready", "pulumi.com/timeoutSeconds": "900" },
            },
            spec: {
                secretName: WILDCARD_SECRET,
                secretTemplate: { labels: { "sprouter.geeko.me/enabled": "true" } },
                dnsNames: [`*.${args.wildcardDomain}`, args.wildcardDomain],
                issuerRef: { name: args.issuer, kind: "ClusterIssuer" },
            },
        }, { ...o, dependsOn: issuers });

        this.registerOutputs({});
    }
}
