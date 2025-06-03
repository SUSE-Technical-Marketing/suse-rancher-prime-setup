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
    // As the file may not be immediately available, we can poll the remote server
    // How often and how long to poll the remote server for the file.
    pollIntervalSeconds?: pulumi.Input<number>;
    pollTimeoutSeconds?: pulumi.Input<number>;
}
// export interface RemoteKubeconfigProviderInputs
//   extends Omit<RemoteKubeconfigInputs, keyof pulumi.Input<any>> {
//   // same fields but concrete types
// }

export interface RemoteKubeconfigProviderInputs {
    hostname: string;
    port?: number;
    username: string;
    password?: string;
    privKey?: string;
    path: string;
    updateServerAddress?: boolean;
    pollIntervalSeconds?: number;
    pollTimeoutSeconds?: number;
}

export interface RemoteKubeconfigProviderOutputs extends RemoteKubeconfigProviderInputs {
    kubeconfig: string;
}

class RemoteKubeconfigProvider implements dynamic.ResourceProvider<RemoteKubeconfigProviderInputs, RemoteKubeconfigProviderOutputs> {
    async create(inputs: RemoteKubeconfigProviderInputs): Promise<dynamic.CreateResult<RemoteKubeconfigProviderOutputs>> {
        const { hostname, port = 22, username, password, privKey, path, pollIntervalSeconds = 5, pollTimeoutSeconds = 300 } = inputs;
        if (!password && !privKey) {
            throw new Error("Either password or private key must be provided for authentication.");
        }


        const deadline = Date.now() + pollTimeoutSeconds * 1_000;
        let kubeconfig: string | undefined;

        while (Date.now() < deadline) {
            pulumi.log.debug(`Checking ${path} on ${hostname}…`);

            kubeconfig = await this.tryFetch(hostname, port, username, password, privKey, path);

            if (kubeconfig !== undefined) break;               // 🎉 got the file
            await new Promise(r => setTimeout(r, pollIntervalSeconds * 1_000));
        }

        if (kubeconfig === undefined) {
            throw new Error(
                `Timed out after ${pollTimeoutSeconds}s waiting for ${path} on ${hostname}`,
            );
        }

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

    async tryFetch(
        host: string,
        port: number,
        user: string,
        pwd: string | undefined,
        key: string | undefined,
        remotePath: string,
    ): Promise<string | undefined> {
        return new Promise((resolve, reject) => {
            const client = new ssh.Client();
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

