import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { cert_manager } from "@lab/crds";
import { onCluster, profileHelmApp } from "@lab/kubernetes";
import { ChartArgs } from "./charts";

export interface CertManagerArgs extends ChartArgs {
    email: string;
    cloudflareToken: pulumi.Input<string>;
    /** The ACME server (an AcmeServer document): the ClusterIssuer is named after it. */
    acme: { name: string; url: string };
    /** `<host>.<domain>`; the certificate covers it and `*.<host>.<domain>`. */
    wildcardDomain: string;
    /** The certificate's secret (the profile's `tls` output); Sprouter copies it into every namespace. */
    secretName: string;
}


/**
 * cert-manager with an ACME issuer (Cloudflare DNS-01) and the host's wildcard certificate.
 * The secret is labelled for Sprouter, which makes it available to ingresses in every namespace.
 */
export class CertManager extends pulumi.ComponentResource {
    readonly certificate: cert_manager.v1.Certificate;

    constructor(name: string, args: CertManagerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:CertManager", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const ns = args.chart.namespace;

        const chart = profileHelmApp(`${name}/chart`, args.chart, { lab: args.values }, o);

        const token = new k8s.core.v1.Secret(`${name}/cloudflare-token`, {
            metadata: { name: "cloudflare-api-token", namespace: ns },
            stringData: { "api-token": pulumi.secret(args.cloudflareToken) },
        }, { ...o, dependsOn: [chart] });

        const issuer = new cert_manager.v1.ClusterIssuer(`${name}/${args.acme.name}`, {
            metadata: { name: args.acme.name },
            spec: {
                acme: {
                    server: args.acme.url,
                    email: args.email,
                    privateKeySecretRef: { name: args.acme.name },
                    solvers: [{ dns01: { cloudflare: { apiTokenSecretRef: { name: token.metadata.name, key: "api-token" } } } }],
                },
            },
        }, { ...o, dependsOn: [chart, token] });

        this.certificate = new cert_manager.v1.Certificate(`${name}/wildcard`, {
            metadata: {
                name: args.secretName,
                namespace: ns,
                annotations: { "pulumi.com/waitFor": "condition=Ready", "pulumi.com/timeoutSeconds": "900" },
            },
            spec: {
                secretName: args.secretName,
                secretTemplate: { labels: { "sprouter.geeko.me/enabled": "true" } },
                dnsNames: [`*.${args.wildcardDomain}`, args.wildcardDomain],
                issuerRef: { name: issuer.metadata.name, kind: "ClusterIssuer" },
            },
        }, { ...o, dependsOn: [issuer] });

        this.registerOutputs({});
    }
}
