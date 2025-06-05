import * as pulumi from "@pulumi/pulumi"
import { helmInstallRancher } from "./rancher";
import * as k8s from "@pulumi/kubernetes";
import { installIngressNginx, installSprouter, TLS, TLSArgs } from "@suse-tmm/common";
import { provisionHarvesterVm } from "./harvester";
import { HarvesterVmArgs } from "./harvester";
import * as k8scfg from "@suse-tmm/kubeconfig";
import { BootstrapAdminPassword } from "./bootstrap";

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
}

export class RancherManagerInstall extends pulumi.ComponentResource {
    public kubeconfig: pulumi.Output<string>;
    public rancherAdminPassword: pulumi.Output<string>;
    public rancherUrl: pulumi.Output<string>;

    constructor(name: string, args: RancherInstallArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:components:RancherManagerInstall", name, {}, opts);
        let installIngress = false;

        let myOpts = {...opts, parent: this };
        if (args.harvester) {
            // Install Rancher on a new VM in Harvester
            const harvesterVm = provisionHarvesterVm(args.harvester, args.harvester.kubeconfig, myOpts);
            const kubeconfig = new k8scfg.RemoteKubeconfig("vm-kubeconfig", {
                hostname: harvesterVm.vmIpAddress,
                username: args.harvester.sshUser,
                privKey: args.harvester.keypair.privateKey,
                path: "/etc/rancher/k3s/k3s.yaml",
                updateServerAddress: true, // We fetch the kubeconfig from the VM which contains 127.0.0.1 as address, we need to update it to the VM's IP address
            }, myOpts);

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

        const bootstrapPassword = new BootstrapAdminPassword("rancher-bootstrap-password", {
            kubeconfig: this.kubeconfig,
            password: args.adminPassword,
            rancherUrl: url,
        }, {
            parent: this,
            dependsOn: [release],
        });
        this.rancherAdminPassword = bootstrapPassword.password;
        // this.rancherAdminPassword = pulumi.output("");

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

        return {
            release: rancherRelease,
            url: `https://${rancherValues.hostname}`
        };
    }
}
