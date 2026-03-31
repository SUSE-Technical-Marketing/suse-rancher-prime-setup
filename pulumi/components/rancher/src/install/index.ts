import * as pulumi from "@pulumi/pulumi"
import { helmInstallRancher } from "./rancher";
import * as k8s from "@pulumi/kubernetes";
import { Sprouter, TLS, TLSArgs, Outrider } from "@suse-tmm/common";
import { RancherLogin } from "@suse-tmm/utils";
import { BootstrapAdminPassword } from "./bootstrap";
import { RancherSetting } from "../resources/setting";

export interface RancherInstallArgs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig for the cluster to install Rancher on
    tls: TLSArgs; // TLS configuration
    hostname?: pulumi.Input<string>; // Hostname for Rancher
    domain?: pulumi.Input<string>; // Domain for Rancher
    adminPassword?: pulumi.Input<string>; // Optional admin password for Rancher
    skipBootstrap?: pulumi.Input<boolean>; // Optional skip the bootstrap for Rancher
    rancherVersion: pulumi.Input<string>; // Rancher version to install
}

export class RancherManagerInstall extends pulumi.ComponentResource {
    public readonly kubeconfig: pulumi.Output<string>;
    public readonly rancherAdminPassword: pulumi.Output<string>;
    public readonly rancherUrl: pulumi.Output<string>;
    public readonly authToken: pulumi.Output<string>;

    constructor(name: string, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:RancherManagerInstall", name, {}, opts);

        this.kubeconfig = pulumi.output(args.kubeconfig);

        const myOpts = { ...opts, parent: this };
        const { release, url } = this.installRancher(this.kubeconfig, args, myOpts);

        this.rancherUrl = pulumi.output(url);
        if (args.skipBootstrap) {
            pulumi.log.info("Skipping bootstrap for Rancher");
            this.rancherAdminPassword = pulumi.output("");
            this.authToken = pulumi.output("");
            this.registerOutputs({
                kubeconfig: this.kubeconfig,
                rancherAdminPassword: this.rancherAdminPassword,
                rancherUrl: this.rancherUrl,
                authToken: this.authToken,
            });
            return;
        }

        const bootstrapPassword = new BootstrapAdminPassword("rancher-bootstrap-password", {
            kubeconfig: this.kubeconfig,
            adminPassword: args.adminPassword,
            rancherUrl: url,
            insecure: args.tls.certManager?.staging || false,
        }, {
            parent: this,
            dependsOn: [release],
        });
        this.rancherAdminPassword = bootstrapPassword.password;

        const authToken = new RancherLogin("rancher-login", {
            server: url,
            username: bootstrapPassword.username,
            password: this.rancherAdminPassword,
            insecure: args.tls.certManager?.staging || false,
        }, {
            parent: this,
            dependsOn: [bootstrapPassword]
        });

        new RancherSetting("server-url", {
            rancher: {
                server: url,
                authToken: authToken.authToken,
                insecure: args.tls.certManager?.staging || false,
            },
            settingName: "server-url",
            settingValue: url,
        }, {
            parent: this,
            dependsOn: [authToken],
        });

        this.rancherUrl = pulumi.output(url);
        this.authToken = authToken.authToken;

        this.registerOutputs({
            kubeconfig: this.kubeconfig,
            rancherAdminPassword: this.rancherAdminPassword,
            rancherUrl: this.rancherUrl,
            authToken: this.authToken,
        });
    }

    installRancher(kubeconfig: pulumi.Input<string>, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        const provider = new k8s.Provider("rancher-install-k8s", {
            kubeconfig: kubeconfig,
        }, { parent: this });

        let resOpts = { ...opts, provider: provider, parent: this };

        // We use sprouter to copy the certificates to all the required namespaces
        Sprouter(resOpts);
        // We use outrider to propagate secrets to downstream clusters
        Outrider(resOpts);

        // Create TLS
        const tls = new TLS("rancher-tls", args.tls, resOpts);

        let rancherValues: { [key: string]: any } = {
            hostname: `rancher.${args.hostname}.${args.domain}`,
        }

        if (tls.tlsSecret) {
            rancherValues = {
                ...rancherValues,
                ingress: {
                    ingressClassName: "traefik",
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
                    ingressClassName: "traefik",
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
                    ingressClassName: "traefik",
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
            rancherVersion: args.rancherVersion,
            values: rancherValues
        }, resOpts);

        return {
            release: rancherRelease,
            url: `https://${rancherValues.hostname}`
        };
    }

    static validateAdminPassword(password: pulumi.Output<string>) {
        password.apply(password => {
            if (password.length < 12) {
                throw new Error("Admin password must be at least 12 characters long");
            }
        });

        return password;
    }
}
