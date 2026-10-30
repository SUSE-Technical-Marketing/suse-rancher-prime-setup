import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { expect } from "vitest";
import { loadLab, type ResolvedLab } from "@lab/schema";
import { register } from "tsx/cjs/api";

// The generated CRD classes load their modules with require(), as under Pulumi's own TypeScript runner.
register();

// Runs the whole program under Pulumi's mocks for a lab, and returns what it registers. One lab
// per test file: the program is a module, run once.

const KUBECONFIG_YAML = `apiVersion: v1
clusters:
- cluster: { certificate-authority-data: Q0E=, server: "https://127.0.0.1:6443" }
  name: default
contexts:
- context: { cluster: default, user: default }
  name: default
current-context: default
kind: Config
users:
- name: default
  user: { client-certificate-data: Q0VSVA==, client-key-data: S0VZ }
`;

export interface Registered { type: string; name: string; inputs: any }

export interface RunOptions {
    secrets: Record<string, unknown>;
    /** Another catalog than the engine's. */
    catalogDir?: string;
    /** Changes to the resolved lab before the program gets it. */
    tweak?: (lab: ResolvedLab) => void;
}

export async function runProgram(LAB: string, opts: RunOptions): Promise<Registered[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-k3k-"));
    fs.writeFileSync(path.join(dir, "lab.yaml"), LAB);
    fs.writeFileSync(path.join(dir, "config.yaml"), "apiVersion: lab.geeko.me/v1alpha1\nkind: PersonalConfig\nmetadata: { name: test }\nspec: {}\n");
    const { lab, diagnostics } = loadLab({ labFile: path.join(dir, "lab.yaml"), personalConfig: path.join(dir, "config.yaml"), catalogDir: opts.catalogDir });
    expect(diagnostics.errors).toEqual([]);
    opts.tweak?.(lab!);

    const registered: Registered[] = [];
    pulumi.runtime.setMocks({
        newResource(args) {
            registered.push({ type: args.type, name: args.name, inputs: args.inputs });
            const state: Record<string, unknown> = { ...args.inputs };
            // What later steps read from outputs: kubeconfigs (a host's over SSH, a downstream cluster's from Rancher).
            if (args.name.endsWith("/kubeconfig") && args.type.startsWith("command:")) state.stdout = KUBECONFIG_YAML;
            if (args.name.endsWith("/kubeconfig") && args.type.startsWith("pulumi-nodejs:dynamic")) {
                state.kubeconfig = JSON.stringify({ clusters: [{ cluster: { server: `https://rancher.example.com/k8s/clusters/c-m-${args.name.split("/")[1]}` } }] });
            }
            if (args.type.startsWith("pulumi-nodejs:dynamic") && !args.name.includes("/ami/")) Object.assign(state, { ipAddress: "10.0.20.100", value: "10.0.20.100", clusterId: "c-m-x", nodeCommand: "true", manifestUrl: "https://rancher.example.com/v3/import/x.yaml", secretName: "cattle-global-data:cc-x", token: "t" });
            return { id: `${args.name}-id`, state };
        },
        call: args => (args.token === "aws:ec2/getAmi:getAmi" ? { id: `ami-${args.inputs.owners[0]}` } : args.inputs),
    }, "lab", "test", false);
    pulumi.runtime.setAllConfig({
        "lab:resolved": JSON.stringify(lab),
        "lab:secrets": JSON.stringify(opts.secrets),
        "lab:owner": "me@example.com",
        "lab:createdAt": "2026-10-29T10:00:00.000Z",
    }, ["lab:secrets"]);

    await import("../index");
    // Registrations finish as their inputs resolve.
    await new Promise(r => setTimeout(r, 1500));
    return registered;
}

