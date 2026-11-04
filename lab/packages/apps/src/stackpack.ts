import * as pulumi from "@pulumi/pulumi";
import { multipartFile, observabilityRequest, poll } from "@lab/kube";
import { describe, waitForApi } from "./observability";

// StackPacks on a SUSE Observability instance (DESIGN.md §9.6), as `sts stackpack upload / install /
// upgrade / uninstall` do it through the REST API: one in the instance's own catalog
// (open-telemetry), or a .sts uploaded first (suse-ai, which `lab stackpacks` builds from source
// before `up`). One per instance and StackPack, while a profile in the lab wants it.

export interface ObservabilityStackPackArgs {
    /** The instance: `https://observability.<cluster>.<domain>`. */
    url: pulumi.Input<string>;
    /** A service token with admin rights (the instance's bootstrap token). */
    adminToken: pulumi.Input<string>;
    name: string;
    /** Its version; none: the catalog's latest. */
    version?: string;
    /** Its .sts (built by `lab stackpacks`) and the sha256 it must have: uploaded first. */
    file?: string;
    sha256?: string;
    unlocked: "fail" | "skip" | "overwrite";
    /** Let's Encrypt staging: don't check the instance's certificate. */
    insecure: boolean;
    /** How long to wait for the instance's API and the StackPack's provisioning. */
    timeoutSeconds: number;
}

type Inputs = Omit<ObservabilityStackPackArgs, "url" | "adminToken"> & { url: string; adminToken: string };

interface Outputs extends Inputs {
    /** Its instance's id, and the version installed. */
    instance: number;
    installedVersion: string;
}

interface Configuration { id?: number; status: string; stackPackVersion?: string; error?: { message?: string } }

/** The StackPack's instances on the instance, and its latest version there; none if it isn't in its catalog. */
async function stackPackOf(i: Inputs): Promise<{ version: string; configurations: Configuration[] } | undefined> {
    const res = await observabilityRequest(i, i.adminToken, "GET", "/stackpack");
    if (res.status !== 200) throw new Error(`listing StackPacks failed: ${describe(res)}`);
    return (res.body as { name: string; version: string; configurations?: Configuration[] }[])
        .filter(p => p.name === i.name)
        .map(p => ({ version: p.version, configurations: p.configurations ?? [] }))[0];
}

/** Its .sts uploaded, unless the instance's catalog has that version already (uploaded versions are immutable). */
async function ensureUploaded(i: Inputs): Promise<void> {
    if (!i.file) return;
    const versions = await observabilityRequest(i, i.adminToken, "GET", `/stackpack/${i.name}/versions`);
    if (versions.status === 200 && (versions.body as { version: string }[]).some(v => v.version === i.version)) return;
    // Required here, not imported: dynamic providers are serialized into the state, modules can't be.
    const fs = require("node:fs") as typeof import("node:fs");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    if (!fs.existsSync(i.file)) throw new Error(`${i.file} isn't there: run "lab stackpacks"`);
    const sts = fs.readFileSync(i.file);
    const sha256 = createHash("sha256").update(sts).digest("hex");
    if (sha256 !== i.sha256) throw new Error(`${i.file} has sha256 ${sha256}, not ${i.sha256}: run "lab stackpacks --force"`);
    const res = await observabilityRequest(i, i.adminToken, "POST", "/stackpack", multipartFile("stackPack", `${i.name}-${i.version}.sts`, sts), 120000);
    if (res.status >= 300) throw new Error(`uploading ${i.name} ${i.version} failed: ${describe(res)}`);
}

/**
 * Its instance: provisioned (`sts stackpack install`), upgraded when it's at another version
 * (`sts stackpack upgrade`), then waited on until it's installed, or waiting for its first data.
 */
async function ensureProvisioned(i: Inputs): Promise<{ instance: number; installedVersion: string }> {
    const pack = await stackPackOf(i);
    if (!pack) throw new Error(`SUSE Observability at ${i.url} has no ${i.name} StackPack`);
    const existing = pack.configurations.find(c => c.id !== undefined);
    const unlocked = `unlocked=${i.unlocked}`;
    if (!existing) {
        const res = await observabilityRequest(i, i.adminToken, "POST", `/stackpack/${i.name}/provision?${unlocked}${i.version ? `&version=${i.version}` : ""}`, {});
        if (res.status >= 300) throw new Error(`installing the ${i.name} StackPack failed: ${describe(res)}`);
    } else if (i.version && existing.stackPackVersion !== i.version) {
        const res = await observabilityRequest(i, i.adminToken, "POST", `/stackpack/${i.name}/upgrade?${unlocked}`);
        if (res.status >= 300) throw new Error(`upgrading the ${i.name} StackPack from ${existing.stackPackVersion} to ${i.version} failed: ${describe(res)}`);
    }
    return poll(async seen => {
        const c = (await stackPackOf(i))?.configurations.find(x => x.id !== undefined);
        if (!c) return undefined;
        seen(`${c.status} (${c.stackPackVersion})`);
        if (c.status === "ERROR") throw new Error(`the ${i.name} StackPack failed to provision: ${c.error?.message ?? "no message"}`);
        const done = (c.status === "INSTALLED" || c.status === "WAITING_FOR_DATA") && (!i.version || c.stackPackVersion === i.version);
        return done ? { instance: c.id!, installedVersion: c.stackPackVersion ?? pack.version } : undefined;
    }, {
        timeoutSeconds: i.timeoutSeconds, everyMs: 3000,
        failure: last => `timed out after ${i.timeoutSeconds}s waiting for the ${i.name} StackPack at ${i.url} (last: ${last})`,
    });
}

/** Exported for its tests. */
export const stackPackProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        await waitForApi(inputs);
        await ensureUploaded(inputs);
        const outs: Outputs = { ...inputs, ...await ensureProvisioned(inputs) };
        return { id: `${inputs.url}/${inputs.name}`, outs };
    },

    async diff(_id: string, olds: Outputs, news: Inputs) {
        // Another instance or StackPack is another one; another version is an upgrade.
        const replaces = (["url", "name"] as const).filter(k => olds[k] !== news[k]);
        const changes = replaces.length > 0 || (["version", "file", "sha256", "unlocked", "adminToken", "insecure", "timeoutSeconds"] as const).some(k => olds[k] !== news[k]);
        return { changes, replaces, deleteBeforeReplace: true };
    },

    async update(_id: string, olds: Outputs, news: Inputs) {
        if (news.version === olds.version) return { outs: { ...news, instance: olds.instance, installedVersion: olds.installedVersion } };
        await waitForApi(news);
        await ensureUploaded(news);
        return { outs: { ...news, ...await ensureProvisioned(news) } };
    },

    /**
     * Uninstall its instance (`sts stackpack uninstall`): no profile wants it any more. An instance
     * that's gone or doesn't answer (the lab is being destroyed, its cluster with it) is skipped.
     */
    async delete(_id: string, props: Outputs) {
        try {
            const probe = await observabilityRequest(props, props.adminToken, "GET", "/stackpack", undefined, 15000);
            if (probe.status !== 200) {
                pulumi.log.warn(`SUSE Observability at ${props.url} answers ${describe(probe)}; not uninstalling ${props.name} there`);
                return;
            }
        } catch (e) {
            pulumi.log.warn(`SUSE Observability at ${props.url} can't be reached (${(e as Error).message}); not uninstalling ${props.name} there`);
            return;
        }
        for (const c of (await stackPackOf(props))?.configurations ?? []) {
            if (c.id === undefined) continue;
            const res = await observabilityRequest(props, props.adminToken, "POST", `/stackpack/${props.name}/deprovision/${c.id}`);
            if (res.status >= 300 && res.status !== 404) throw new Error(`uninstalling the ${props.name} StackPack failed: ${describe(res)}`);
        }
    },
};

/** A StackPack on a SUSE Observability instance: uploaded if it's a file, installed, upgraded with its version. */
export class ObservabilityStackPack extends pulumi.dynamic.Resource {
    declare readonly instance: pulumi.Output<number>;
    declare readonly installedVersion: pulumi.Output<string>;

    constructor(name: string, args: ObservabilityStackPackArgs, opts?: pulumi.CustomResourceOptions) {
        super(stackPackProvider, name, { ...args, instance: undefined, installedVersion: undefined }, { ...opts, additionalSecretOutputs: ["adminToken"] }, "lab", "ObservabilityStackPack");
    }
}
