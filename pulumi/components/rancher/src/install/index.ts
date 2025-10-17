import * as pulumi from "@pulumi/pulumi"
import { helmInstallRancher } from "./rancher";
import * as k8s from "@pulumi/kubernetes";
import { installIngressNginx, installSprouter, TLS, TLSArgs } from "@suse-tmm/common";
import { provisionHarvesterVm } from "./harvester";
import { HarvesterVmArgs } from "./harvester";
import { kubeconfig as k8scfg, RancherLogin } from "@suse-tmm/utils";
import { BootstrapAdminPassword } from "./bootstrap";
import { RancherSetting } from "../resources/setting";
import * as command from "@pulumi/command";

export interface HarvesterArgs extends HarvesterVmArgs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Harvester cluster
}

export interface RancherInstallArgs {
    kubeconfig?: pulumi.Input<string>; // Install on existing cluster
    harvester?: HarvesterArgs; // Install Rancher on new VM in Harvester
    ec2?: pulumi.Input<any>; // Install on EC2 instance type
    tls: TLSArgs; // TLS configuration
    hostname?: pulumi.Input<string>; // Hostname for Rancher
    domain?: pulumi.Input<string>; // Domain for Rancher
    adminPassword?: pulumi.Input<string>; // Optional admin password for Rancher
    skipBootstrap?: pulumi.Input<boolean>; // Optional skip the bootstrap for Rancher
    version: pulumi.Input<string>; // Optional Rancher version to install
}

export class RancherManagerInstall extends pulumi.ComponentResource {
    public readonly kubeconfig: pulumi.Output<string>;
    public readonly rancherAdminPassword: pulumi.Output<string>;
    public readonly rancherUrl: pulumi.Output<string>;

    constructor(name: string, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:RancherManagerInstall", name, {}, opts);
        let installIngress = false;

        let myOpts = { ...opts, parent: this };
        if (args.harvester) {
            // Install Rancher on a new VM in Harvester
            const harvesterVm = provisionHarvesterVm(args.harvester, args.harvester.kubeconfig, myOpts);

            const waitForCloudInit = new command.remote.Command("wait-cloudinit", {
                connection: {
                    host: harvesterVm.vmIpAddress,
                    user: args.harvester.sshUser,
                    privateKey: args.harvester.keypair.privateKey,
                    dialErrorLimit: 20,
                    perDialTimeout: 30,
                },
                // This exits when cloud-init completes (or fails non-zero if it errors)
                create: "sudo cloud-init status --wait",
            }, { ...myOpts, dependsOn: [harvesterVm] });
            const kubeconfig = new k8scfg.RemoteKubeconfig("vm-kubeconfig", {
                hostname: harvesterVm.vmIpAddress,
                username: args.harvester.sshUser,
                privKey: args.harvester.keypair.privateKey,
                path: "/etc/rancher/k3s/k3s.yaml",
                updateServerAddress: true,
                insecure: args.tls.certManager?.staging || false, // If using staging certs, we need to skip TLS verification
                pollDelaySeconds: 10, // Lets the network routes stabilize before trying to access the VM
            }, {...myOpts, dependsOn: [waitForCloudInit] });

            this.kubeconfig = kubeconfig.kubeconfig;
            myOpts = { ...myOpts, dependsOn: [kubeconfig, harvesterVm] };
            installIngress = true; // We need to install Ingress NGINX on the new VM
        } else if (args.kubeconfig) {
            // We are installing Rancher on an existing cluster, no need to provision a new VM
            this.kubeconfig = pulumi.output(args.kubeconfig);
        } else {
            throw new Error("Either 'harvester' or 'kubeconfig' must be provided to install Rancher.");
        }

        const { release, url } = this.installRancher(this.kubeconfig, args, installIngress, myOpts);

        this.rancherUrl = pulumi.output(url);
        if (args.skipBootstrap) {
            pulumi.log.info("Skipping bootstrap for Rancher");
            this.rancherAdminPassword = pulumi.output("");
            this.registerOutputs({
                kubeconfig: this.kubeconfig,
                rancherAdminPassword: this.rancherAdminPassword,
                rancherUrl: this.rancherUrl,
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
            rancherServer: url,
            username: bootstrapPassword.username,
            password: this.rancherAdminPassword,
            insecure: args.tls.certManager?.staging || false,
        }, {
            parent: this,
            dependsOn: [bootstrapPassword]
        });

        new RancherSetting("server-url", {
            rancherServer: url,
            authToken: authToken.authToken,
            settingName: "server-url",
            settingValue: url,
            insecure: args.tls.certManager?.staging || false,
        }, {
            parent: this,
            dependsOn: [authToken],
        });

        this.rancherUrl = pulumi.output(url);

        this.registerOutputs({
            kubeconfig: this.kubeconfig,
            rancherAdminPassword: this.rancherAdminPassword,
            rancherUrl: this.rancherUrl,
        });
    }

    installRancher(kubeconfig: pulumi.Input<string>, args: RancherInstallArgs, installIngress: boolean, opts?: pulumi.ComponentResourceOptions) {
        const provider = new k8s.Provider("kubernetes", {
            kubeconfig: kubeconfig,
        }, { parent: this });

        let resOpts = { ...opts, provider: provider, parent: this };

        // We use sprouter to copy the certificates to all the required namespaces
        installSprouter(resOpts);

        if (installIngress) {
            // Install NGINX Ingress Controller
            installIngressNginx(resOpts);
        }

        // Create TLS
        const tls = new TLS("rancher-tls", args.tls, resOpts);

        let rancherValues: { [key: string]: any } = {
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
            rancherVersion: args.version,
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
