import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import * as ssh from "ssh2";
import { fileSync } from "tmp";
import { writeFileSync, readFile } from "fs";
import { promisify } from "util";
import { load, dump } from "js-yaml";

// This module provides a dynamic resource for fetching a kubeconfig file from a remote server
// using SSH. It allows users to specify the hostname, port, username, and either a password or private key for authentication.

export interface RemoteKubeconfigInputs {
    hostname: pulumi.Input<string>;
    port?: pulumi.Input<number>;
    username: pulumi.Input<string>;
    password?: pulumi.Input<string>;
    privKey?: pulumi.Input<string>;
    // Path to the kubeconfig file on the remote server
    path: pulumi.Input<string>;
    updateServerAddress?: pulumi.Input<boolean>;
}

export interface RemoteKubeconfigProviderInputs {
    hostname: string;
    port?: number;
    username: string;
    password?: string;
    privKey?: string;
    path: string;
    updateServerAddress?: boolean;
}

export interface RemoteKubeconfigProviderOutputs extends RemoteKubeconfigProviderInputs {
    kubeconfig: string;
}

class RemoteKubeconfigProvider implements dynamic.ResourceProvider<RemoteKubeconfigProviderInputs, RemoteKubeconfigProviderOutputs> {
    async create(inputs: RemoteKubeconfigProviderInputs): Promise<dynamic.CreateResult<RemoteKubeconfigProviderOutputs>> {
        const { hostname, port, username, password, privKey, path } = inputs;
        if (!password && !privKey) {
            throw new Error("Either password or private key must be provided for authentication.");
        }

        let kubeconfig = await new Promise<string>((resolve, reject) => {
            const client = new ssh.Client();

            client
                .on("ready", () => {
                    pulumi.log.info(`SSH ready on ${hostname}`);

                    client.sftp((err, sftp) => {
                        if (err) return reject(err);

                        sftp.readFile(path, { encoding: "utf8" }, (err, data) => {
                            client.end();
                            if (err) return reject(err);
                            resolve(data.toString("utf8"));
                        });
                    });
                })
                .on("error", reject)
                .connect({
                    host: hostname,
                    port: port || 22,
                    username,
                    password,
                    privateKey: privKey,
                });
        });

        if (inputs.updateServerAddress) {
            // Update the server address in the kubeconfig
            const doc = load(kubeconfig) as any;
            doc.clusters[0].cluster.server = `https://${hostname}:6443`;
            kubeconfig = dump(doc);
        }

        return {
            id: `kubeconfig-${hostname}-${Date.now()}`,
            outs: { ...inputs, kubeconfig: kubeconfig },
        };
    }

    async diff(id: pulumi.ID, olds: RemoteKubeconfigProviderOutputs, news: RemoteKubeconfigProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return {
            changes: olds.hostname !== news.hostname ||
                olds.path !== news.path ||
                olds.updateServerAddress !== news.updateServerAddress
        };
    }

    update(id: pulumi.ID, olds: RemoteKubeconfigProviderOutputs, news: RemoteKubeconfigProviderInputs): Promise<pulumi.dynamic.UpdateResult<RemoteKubeconfigProviderOutputs>> {
        return this.create(news);
    }
}


export class RemoteKubeconfig extends dynamic.Resource {
    public readonly kubeconfig!: pulumi.Output<string>;

    constructor(name: string, args: RemoteKubeconfigInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new RemoteKubeconfigProvider(), name, { kubeconfig: undefined, ...args }, { ...opts, additionalSecretOutputs: ["kubeconfig"] });
    }
}

