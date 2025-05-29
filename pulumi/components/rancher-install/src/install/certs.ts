import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { cert_manager } from "@suse-tmm/rancher-crds";

export interface TLSArgs {
    certificate?: CertArgs; // Custom TLS certificate
    certManager?: CertManagerArgs; // Cert Manager configuration
}

export interface CertArgs {
    cert: pulumi.Input<string>; // Base64 encoded certificate
    key: pulumi.Input<string>; // Base64 encoded private key
}

export interface CertManagerArgs {
    version?: pulumi.Input<string>; // Optional: specify Cert Manager version
    letsEncryptEmail: pulumi.Input<string>; // Email for Let's Encrypt
    cloudFlareApiToken: pulumi.Input<string>; // Cloudflare API token for DNS validation
}

export const RancherTLSSecretName = "rancher-tls";


export function handleCustomTLS(tls: TLSArgs, opts?: pulumi.ComponentResourceOptions): k8s.core.v1.Secret {
    if (!tls.certificate) {
        throw new Error("Custom TLS certificate is required.");
    }

    const ns = new k8s.core.v1.Namespace("cattle-system", {
        metadata: {
            name: "cattle-system",
        },
    }, opts);

    return new k8s.core.v1.Secret(RancherTLSSecretName, {
        metadata: {
            name: RancherTLSSecretName,
            namespace: ns.metadata.name,
        },
        type: "kubernetes.io/tls",
        data: {
            "tls.crt": tls.certificate.cert,
            "tls.key": tls.certificate.key,
        },
    }, opts);
}

export function installCertManager(certManager: CertManagerArgs, opts?: pulumi.ComponentResourceOptions): k8s.helm.v3.Release {
    const ns = new k8s.core.v1.Namespace("cert-manager", {
        metadata: {
            name: "cert-manager",
        },
    }, opts);

    const cm = new k8s.helm.v3.Release("cert-manager", {
        name: "cert-manager",
        chart: "cert-manager",
        version: certManager.version, // Default version if not specified
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
    }, opts);

    const apiToken = new k8s.core.v1.Secret("cloudflare-api-token", {
        metadata: {
            name: "cloudflare-api-token",
            namespace: ns.metadata.name,
        },
        type: "Opaque",
        stringData: {
            "api-token": certManager.cloudFlareApiToken,
        },
    }, {...opts, dependsOn: [cm]});

    new cert_manager.ClusterIssuer("letsencrypt-prod", {
        metadata: {
            name: "letsencrypt-prod",
            namespace: ns.metadata.name, // Use the same namespace as cert-manager
        },
        spec: {
            acme: {
                server: "https://acme-v02.api.letsencrypt.org/directory",
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
    }, {...opts, dependsOn: [apiToken, cm]});

    return cm;
}
