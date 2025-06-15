import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { cert_manager } from "@suse-tmm/common-crds";

const WildcardCertificateSecretName = "wildcard-cert";

export interface TLSArgs {
    certificate?: CustomCertArgs; // Custom TLS certificate
    certManager?: CertManagerArgs; // Cert-Manager configuration
}

export interface CustomCertArgs {
    cert: pulumi.Input<string>; // Base64 encoded certificate
    key: pulumi.Input<string>; // Base64 encoded private key
}

export interface CertManagerArgs {
    version?: pulumi.Input<string>; // Optional: specify Cert Manager version
    letsEncryptEmail: pulumi.Input<string>; // Email for Let's Encrypt
    cloudFlareApiToken: pulumi.Input<string>; // Cloudflare API token for DNS validation
    wildcardDomain?: pulumi.Input<string>; // Optional: domain for wildcard certificate
    staging?: pulumi.Input<boolean>; // Optional: use staging environment for Let's Encrypt
}

export class TLS extends pulumi.ComponentResource {
    public readonly tlsSecret?: k8s.core.v1.Secret;
    public readonly certificate?: cert_manager.Certificate;

    constructor(name: string, args: TLSArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:TLS", name, {}, opts);
        const resourceOpts = { ...opts, parent: this };
        if (args.certificate) {
            this.tlsSecret = this.handleCustomTLS(args.certificate, resourceOpts);
        } else if (args.certManager) {
            this.certificate = this.installCertManager(args.certManager, resourceOpts);
        } else {
            pulumi.log.warn("No TLS configuration provided, using non-secure settings.");
        }

        this.registerOutputs({
            tlsSecret: this.tlsSecret,
            certificate: this.certificate,
        });
    }

    private handleCustomTLS(cert: CustomCertArgs, opts?: pulumi.ComponentResourceOptions): k8s.core.v1.Secret {
        const ns = new k8s.core.v1.Namespace("cattle-system", {
            metadata: {
                name: "cattle-system",
            },
        }, { ...opts, retainOnDelete: true });
        return new k8s.core.v1.Secret("custom-tls", {
            metadata: {
                name: "custom-tls",
                namespace: ns.metadata.name, // Use the cattle-system namespace
            },
            type: "kubernetes.io/tls",
            data: {
                "tls.crt": cert.cert,
                "tls.key": cert.key,
            },
        }, { ...opts, parent: ns });
    }

    private installCertManager(certManager: CertManagerArgs, opts?: pulumi.ComponentResourceOptions): cert_manager.Certificate | undefined {
        const ns = new k8s.core.v1.Namespace("cert-manager", {
            metadata: {
                name: "cert-manager",
            },
        }, { ...opts, retainOnDelete: true });

        const cm = new k8s.helm.v3.Release("cert-manager", {
            name: "cert-manager",
            chart: "cert-manager",
            version: certManager.version,
            namespace: ns.metadata.name,
            repositoryOpts: {
                repo: "https://charts.jetstack.io",
            },
            values: {
                crds: {
                    enabled: true
                },
                dns01RecursiveNameserversOnly: true,
                dns01RecursiveNameservers: "8.8.8.8:53,1.1.1.1:53"
            },
        }, { ...opts, parent: ns });

        const ci = this.setupClusterIssuer(ns, certManager, { ...opts, dependsOn: [cm], parent: ns });
        if (certManager.wildcardDomain) {
            pulumi.log.info(`Setting up wildcard certificate for domain: ${certManager.wildcardDomain}`);
            return this.createWildcardCertificate(ns, ci, certManager, { ...opts, dependsOn: [ci,cm], parent: ns });
        }
        return undefined; // No domain specified, no certificate created
    }

    private setupClusterIssuer(ns: k8s.core.v1.Namespace, certManager: CertManagerArgs, opts?: pulumi.ComponentResourceOptions): cert_manager.ClusterIssuer {
        const apiToken = new k8s.core.v1.Secret("cloudflare-api-token", {
            metadata: {
                name: "cloudflare-api-token",
                namespace: ns.metadata.name,
            },
            type: "Opaque",
            stringData: {
                "api-token": certManager.cloudFlareApiToken,
            },
        }, { ...opts, retainOnDelete: true });

        return new cert_manager.ClusterIssuer("letsencrypt-prod", {
            metadata: {
                name: "letsencrypt-prod",
                namespace: ns.metadata.name, // Use the same namespace as cert-manager
            },
            spec: {
                acme: {
                    server: certManager.staging ? "https://acme-staging-v02.api.letsencrypt.org/directory": "https://acme-v02.api.letsencrypt.org/directory",
                    email: certManager.letsEncryptEmail,
                    privateKeySecretRef: {
                        name: "letsencrypt-prod",
                    },
                    solvers: [
                        {
                            dns01: {
                                cloudflare: {
                                    apiTokenSecretRef: {
                                        name: apiToken.metadata.name, // introduce dependency
                                        key: "api-token",
                                    },
                                },
                            },
                        },
                    ],
                },
            },
        }, { ...opts, dependsOn: [apiToken] });
    }

    private createWildcardCertificate(ns: k8s.core.v1.Namespace, ci: cert_manager.ClusterIssuer, certManager: CertManagerArgs, opts?: pulumi.ComponentResourceOptions): cert_manager.Certificate {
        // Install wildcard certificate for the specified domain
        return new cert_manager.Certificate(WildcardCertificateSecretName, {
            metadata: {
                name: WildcardCertificateSecretName,
                namespace: ns.metadata.name, // Use the same namespace as cert-manager
                annotations: {
                    "pulumi.com/waitFor": "condition=Ready"
                }
            },
            spec: {
                secretTemplate: {
                    annotations: {
                        "sprouter.geeko.me/enabled": "true"
                    }
                },
                secretName: WildcardCertificateSecretName,
                dnsNames: [`*.${certManager.wildcardDomain}`, `${certManager.wildcardDomain}`],
                issuerRef: {
                    name: ci.metadata.name,
                    kind: ci.kind
                }
            }
        }, opts);
    }
}
