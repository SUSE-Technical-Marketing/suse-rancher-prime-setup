import * as pulumi from "@pulumi/pulumi"
import { helmInstallRancher } from "./rancher";
import * as k8s from "@pulumi/kubernetes";
import { handleCustomTLS, installCertManager, RancherTLSSecretName, TLSArgs } from "./certs"

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
    harvester?: pulumi.Input<HarvesterArgs>; // Install Rancher on new VM in Harvester
    ec2?: pulumi.Input<any>; // Install on EC2 instance type
    tls: pulumi.Input<TLSArgs>; // TLS configuration
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
            // Install Rancher on existing cluster
            // this.kubeconfig = pulumi.output(args.kubeconfig);
            // this.rancherUrl = pulumi.output("https://rancher.example.com");
            // this.rancherUsername = pulumi.output("admin");
            // this.rancherPassword = pulumi.output("password");
        }
    }

    installRancher(kubeconfig: pulumi.Input<string>, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        const provider = new k8s.Provider("kubernetes", {
            kubeconfig: args.kubeconfig,
        }, { parent: this });

        const tlsResource = pulumi.all([args.tls]).apply(([tls]) => {
            if (tls.certificate) {
                return handleCustomTLS(tls, { parent: this, provider: provider });
            } else if (tls.certManager) {
                // Handle Cert Manager configuration
                return installCertManager(tls.certManager, { parent: this, provider: provider });
            } else {
                pulumi.log.warn("No TLS configuration provided, using non-secure settings.");
                return undefined; // No TLS configuration
            }
        });

        const rancherRelease = helmInstallRancher("rancher", {
            rancherVersion: "v2.11.2",
            values: {
                hostname: "rancher.flightdeck.lab.geeko.me",
                ingress: {
                    tls: {
                        source: "secret",
                        secretName: RancherTLSSecretName
                    },
                    extraAnnotations: {
                        "cert-manager.io/cluster-issuer": "letsencrypt-prod"
                    },
                }
            }
        }, { parent: this, provider: provider });
    }
}
