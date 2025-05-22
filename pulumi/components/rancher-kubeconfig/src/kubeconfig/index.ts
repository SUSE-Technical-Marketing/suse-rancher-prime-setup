import * as pulumi from "@pulumi/pulumi";
import axios from "axios";
import https from "https";
import * as yaml from "yaml";

export interface RancherKubeconfigOpts {
    url: pulumi.Input<string>;
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>;
}

export class RancherKubeconfig extends pulumi.ComponentResource {
    public kubeconfig: pulumi.Output<string>;
    constructor(name: string, opts: RancherKubeconfigOpts, customResourceOptions?: pulumi.CustomResourceOptions) {
        super("suse-tmm:components:rancher-kubeconfig", name, {}, customResourceOptions);

        this.kubeconfig = getRancherKubeconfig(opts);
        this.registerOutputs({
            kubeconfig: this.kubeconfig
        });
    }
}

export function getRancherKubeconfig(opts: RancherKubeconfigOpts): pulumi.Output<string> {
    // Deal with self-signed certs
    const httpsAgent = new https.Agent({
        rejectUnauthorized: false
    });

    const bearerToken = loginRancher(opts, httpsAgent);
    const kubeconfig = downloadKubeconfig(opts, bearerToken, httpsAgent);

    return kubeconfig.apply((kubeconfig) => {
        // Check if pulumi is in dry run mode
        // If it is, we don't want to make any API calls
        // because we don't have the credentials yet
        if (pulumi.runtime.isDryRun()) {
            return "";
        }

        if (opts.insecure) {
            const kubeyaml = yaml.parse(kubeconfig);
            kubeyaml.clusters[0].cluster["insecure-skip-tls-verify"] = true;
            delete kubeyaml.clusters[0].cluster["certificate-authority-data"];
            return yaml.stringify(kubeyaml);
        } else {
            return kubeconfig;
        }
    });
}

function loginRancher(opts: RancherKubeconfigOpts, agent: https.Agent): pulumi.Output<string> {
    return pulumi.all([opts.url, opts.username, opts.password]).apply(async ([url, username, password]) => {
        // Check if pulumi is in dry run mode
        // If it is, we don't want to make any API calls
        // because we don't have the credentials yet
        if (pulumi.runtime.isDryRun()) {
            return "";
        }

        return await axios.post(`${url}/v3-public/localProviders/local?action=login`, {
            username: username,
            password: password
        }, {
            httpsAgent: agent
        }).then((response) => {
            return response.data.token as string;
        }).catch((error) => {
            console.error("Error logging in to Harvester:", error);
            throw error;
        });
    });
}

function downloadKubeconfig(opts: RancherKubeconfigOpts, bearerToken: pulumi.Input<string>, agent: https.Agent): pulumi.Output<string> {
    return pulumi.all([opts.url, opts.clusterName, bearerToken]).apply(async ([url, clusterName, bearerToken]) => {
        // Check if pulumi is in dry run mode
        // If it is, we don't want to make any API calls
        // because we don't have the credentials yet
        if (pulumi.runtime.isDryRun()) {
            return "";
        }

        return await axios.post(`${opts.url}/v1/management.cattle.io.clusters/${opts.clusterName}?action=generateKubeconfig`, {}, {
            headers: {
                Authorization: `Bearer ${bearerToken}`
            },
            httpsAgent: agent
        }).then((response) => {
            return response.data.config as string;
        }).catch((error) => {
            console.error("Error generating kubeconfig:", error);
            throw error;
        });
    });
}
