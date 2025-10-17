import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { KubeConfig } from ".";
import { Client } from "ssh2";
import { waitFor } from "../../functions/waitfor";
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
    insecure?: pulumi.Input<boolean>;
    // As the file may not be immediately available, we can poll the remote server
    // How often and how long to poll the remote server for the file.
    pollIntervalSeconds?: pulumi.Input<number>;
    pollTimeoutSeconds?: pulumi.Input<number>;
    pollDelaySeconds?: pulumi.Input<number>; // Optional delay before starting to poll
}

interface RemoteKubeconfigProviderInputs {
    hostname: string;
    port?: number;
    username: string;
    password?: string;
    privKey?: string;
    path: string;
    updateServerAddress?: boolean;
    insecure?: boolean;
    pollIntervalSeconds?: number;
    pollTimeoutSeconds?: number;
    pollDelaySeconds?: number; // Optional delay before starting to poll
}


interface RemoteKubeconfigProviderOutputs extends RemoteKubeconfigProviderInputs {
    kubeconfig: string;
}

class RemoteKubeconfigProvider implements dynamic.ResourceProvider<RemoteKubeconfigProviderInputs, RemoteKubeconfigProviderOutputs> {
    async create(inputs: RemoteKubeconfigProviderInputs): Promise<dynamic.CreateResult<RemoteKubeconfigProviderOutputs>> {
        const { hostname, port = 22, username, password, privKey, path, pollIntervalSeconds = 5, pollTimeoutSeconds = 300 } = inputs;
        if (!password && !privKey) {
            throw new Error("Either password or private key must be provided for authentication.");
        }

        return waitFor(() => this.tryFetch(hostname, port, username, password, privKey, path), {
            intervalMs: pollIntervalSeconds * 1_000,
            timeoutMs: pollTimeoutSeconds * 1_000,
            delayMs: inputs.pollDelaySeconds ? inputs.pollDelaySeconds * 1_000 : 0, // Optional delay before starting to poll
        }).then(kc => {
            let kubecfg = new KubeConfig(kc!);
            kubecfg = inputs.insecure ? kubecfg.insecure() : kubecfg;
            kubecfg = inputs.updateServerAddress ? kubecfg.updateServerAddress(hostname, 6443) : kubecfg;
            return kubecfg;
        }).catch(err => {
            pulumi.log.error(`Failed to fetch kubeconfig from ${hostname}:${port} at ${path}: ${err.message}`);
            throw new Error(`Failed to fetch kubeconfig from ${hostname}:${port} at ${path}: ${err.message}`);
        }).then((kubeconfig) => {
            return {
                id: `kubeconfig-${hostname}-${Date.now()}`,
                outs: { ...inputs, kubeconfig: kubeconfig.kubeconfig },
            };
        });
    }

    async tryFetch(
        host: string,
        port: number,
        user: string,
        pwd: string | undefined,
        key: string | undefined,
        remotePath: string,
    ): Promise<string | undefined> {
        return new Promise((resolve, reject) => {
            const client = new Client();
            client.on("ready", () => {
                client.sftp((err, sftp) => {
                    if (err) { client.end(); return reject(err); }

                    sftp.readFile(remotePath, { encoding: "utf8" }, (err, data) => {
                        client.end();
                        if (!err) return resolve(data.toString("utf8"));

                        // File not found yet → tell caller to retry
                        if ((err as any).code === 2 /* ENOENT */) return resolve(undefined);
                        // Any other error should fail the whole provider
                        reject(err);
                    });
                });
            })
                .on("error", reject)
                .connect({ host, port, username: user, password: pwd, privateKey: key });
        });
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

