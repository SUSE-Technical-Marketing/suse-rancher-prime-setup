import * as pulumi from "@pulumi/pulumi"
import { helmInstallRancher } from "./rancher";
import * as k8s from "@pulumi/kubernetes";
import { installIngressNginx, installSprouter, TLS, TLSArgs } from "@suse-tmm/common";

export interface HarvesterArgs {
    url: pulumi.Input<string>;
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
    vmName: pulumi.Input<string>;
    vmNamespace: pulumi.Input<string>;
    vmImage: pulumi.Input<string>;
}

export interface RancherInstallArgs {
    kubeconfig?: pulumi.Input<string>; // Install on existing cluster
    harvester?: HarvesterArgs; // Install Rancher on new VM in Harvester
    installIngress?: pulumi.Input<boolean>; // Install Ingress controller
    ec2?: pulumi.Input<any>; // Install on EC2 instance type
    tls: TLSArgs; // TLS configuration
    hostname?: pulumi.Input<string>; // Hostname for Rancher
    domain?: pulumi.Input<string>; // Domain for Rancher
}

export class RancherManagerInstall extends pulumi.ComponentResource {
    // public kubeconfig: pulumi.Output<string>;
    // public rancherUrl: pulumi.Output<string>;
    // public rancherPassword: pulumi.Output<string>;
    // public rancherUsername: pulumi.Output<string>;

    constructor(name: string, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:RancherManagerInstall", name, {}, opts);

        if (args.kubeconfig) {
            this.installRancher(args.kubeconfig, args, opts);
        }
    }

    installRancher(kubeconfig: pulumi.Input<string>, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        const provider = new k8s.Provider("kubernetes", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });

        let resOpts = { ...opts, provider: provider, parent: this };

        installSprouter(resOpts)
        if (args.installIngress) {
            // Install NGINX Ingress Controller
            installIngressNginx(resOpts);
        }

        // Create TLS
        const tls = new TLS("rancher-tls", args.tls, resOpts);

        let rancherValues: {[key: string]: any} = {
            hostname: `rancher.${args.hostname}.${args.domain}`,
        }

        if (tls.tlsSecret) {
            rancherValues = {
                ...rancherValues,
                ingress: {
                    ingressClassName: "nginx",
                    tls: {
                        source: "secret",
                        secretName: tls.tlsSecret?.metadata.name
                    },
                }
            };
        } else if (tls.certificate) {
            rancherValues = {
                ...rancherValues,
                ingress: {
                    ingressClassName: "nginx",
                    tls: {
                        source: "secret",
                        secretName: tls.certificate.metadata.name
                    },
                }
            };
        } else if (args.tls.certManager && !tls.certificate) {
            // Cert-Manager is configured, but no wildcard certificate is created yet
            rancherValues = {
                ...rancherValues,
                ingress: {
                    ingressClassName: "nginx",
                    tls: {
                        source: "secret",
                        secretName: "rancher-tls",
                    },
                    extraAnnotations: {
                        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
                    }
                }
            };
        }

        const rancherRelease = helmInstallRancher("rancher", {
            rancherVersion: "v2.11.2",
            values: rancherValues
        }, { parent: this, provider: provider });
    }
}
