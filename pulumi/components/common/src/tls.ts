import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { cert_manager } from "@suse-tmm/common-crds";
import { CertManager } from "./apps";

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

    private installCertManager(certManager: CertManagerArgs, opts: pulumi.ComponentResourceOptions): cert_manager.Certificate | undefined {
        const cm = CertManager(certManager.version!, opts);

        const apiToken = new k8s.core.v1.Secret("cloudflare-api-token", {
            metadata: {
                name: "cloudflare-api-token",
                namespace: cm.namespaceName,
            },
            type: "Opaque",
            stringData: {
                "api-token": certManager.cloudFlareApiToken,
            },
        }, { ...opts, dependsOn: [cm], retainOnDelete: true, parent: cm});

        const prodCi = this.setupClusterIssuer(cm.namespaceName, "letsencrypt-prod", "https://acme-v02.api.letsencrypt.org/directory", certManager, apiToken, { ...opts, dependsOn: [cm] });
        const stagingCi = this.setupClusterIssuer(cm.namespaceName, "letsencrypt-staging", "https://acme-staging-v02.api.letsencrypt.org/directory", certManager, apiToken, { ...opts, dependsOn: [cm] });
        if (certManager.wildcardDomain) {
            pulumi.log.info(`Setting up wildcard certificate for domain: ${certManager.wildcardDomain}`);
            return this.createWildcardCertificate(cm.namespaceName, certManager.staging ? stagingCi : prodCi, certManager, { ...opts, dependsOn: [stagingCi, prodCi, cm] });
        }
        return undefined; // No domain specified, no certificate created
    }

    private setupClusterIssuer(ns: pulumi.Input<string>, name: string, url: string, certManager: CertManagerArgs, apiToken: k8s.core.v1.Secret, opts?: pulumi.ComponentResourceOptions): cert_manager.ClusterIssuer {
        return new cert_manager.ClusterIssuer(name, {
                metadata: {
                    name: name,
                    namespace: ns, // Use the same namespace as cert-manager
                },
                spec: {
                    acme: {
                        server: url,
                        email: certManager.letsEncryptEmail,
                        privateKeySecretRef: {
                            name: name,
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

    private createWildcardCertificate(ns: pulumi.Input<string>, ci: cert_manager.ClusterIssuer, certManager: CertManagerArgs, opts?: pulumi.ComponentResourceOptions): cert_manager.Certificate {
        // Install wildcard certificate for the specified domain
        return new cert_manager.Certificate(WildcardCertificateSecretName, {
            metadata: {
                name: WildcardCertificateSecretName,
                namespace: ns, // Use the same namespace as cert-manager
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
