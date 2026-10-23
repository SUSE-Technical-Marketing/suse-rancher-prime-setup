import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    claim, HarvesterApi, HarvesterOwnerStore, isSupportedHarvesterVersion, MIN_HARVESTER_VERSION,
    Owner, release,
} from "@lab/core";
import { ResolvedHarvester, ResolvedLab } from "@lab/schema";
import { log } from "./log";
import { credentialsFrom, ResolvedSecret } from "./secrets";

/** The person running the CLI, as recorded in a Harvester's ownership claim. */
export function currentUser(): string {
    try {
        const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (email) return email;
    } catch {
        // no git or no email configured
    }
    return os.userInfo().username;
}

/** A logged-in connection to one Harvester, used for the claim and, as a kubeconfig, by Pulumi. */
export interface HarvesterSession {
    harvester: ResolvedHarvester;
    api: HarvesterApi;
    version?: string;
}

/** Long enough for a full `up` (image downloads, MLM sync); the CLI logs out when it's done. */
const SESSION_TTL_MS = 8 * 3600 * 1000;

export async function openSessions(lab: ResolvedLab, secrets: Record<string, ResolvedSecret>, only?: string[]): Promise<HarvesterSession[]> {
    const sessions: HarvesterSession[] = [];
    try {
        for (const h of lab.harvesters.filter(h => !only || only.includes(h.name))) {
            const { username, password } = credentialsFrom(h.credentials, secrets);
            const api = await HarvesterApi.login({ url: h.url, username, password, insecure: h.insecure, ttlMs: SESSION_TTL_MS });
            const session: HarvesterSession = { harvester: h, api };
            sessions.push(session);
            session.version = await api.serverVersion();
            const supported = session.version ? isSupportedHarvesterVersion(session.version) : undefined;
            const min = `v${MIN_HARVESTER_VERSION.major}.${MIN_HARVESTER_VERSION.minor}`;
            if (supported === false) throw new Error(`harvester "${h.name}" runs ${session.version}; the lab engine needs ${min} or newer`);
            if (supported === undefined) log.warn(`harvester "${h.name}": couldn't determine its version${session.version ? ` ("${session.version}")` : ""}; assuming ${min} or newer`);
        }
    } catch (e) {
        await closeSessions(sessions);
        throw e;
    }
    return sessions;
}

export async function closeSessions(sessions: HarvesterSession[]): Promise<void> {
    await Promise.all(sessions.map(s => s.api.logout()));
}

/**
 * Write the files one run needs and return the environment pointing at them:
 * - a kubeconfig with one context per Harvester (named after it), so Pulumi's Kubernetes
 *   providers pick their context by name and no credentials end up in state;
 * - empty Docker and Helm registry configs, so public OCI charts don't trip over a credential
 *   helper configured in the user's own ~/.docker/config.json.
 */
export function writeRunFiles(labName: string, sessions: HarvesterSession[]): { env: Record<string, string>; cleanup(): void } {
    // A fixed path per lab: the Kubernetes provider records the KUBECONFIG *path* in state (never
    // its contents), and a later `destroy` must find a file there. Only exists during a run.
    const dir = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "lab", "run", labName);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "config.json"), "{}\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "registry.json"), "{}\n", { mode: 0o600 });
    const file = path.join(dir, "kubeconfig.json");
    const entries = sessions.map(s => s.api.kubeconfigEntry(s.harvester.name));
    const kubeconfig = {
        apiVersion: "v1",
        kind: "Config",
        clusters: entries.map(e => e.cluster),
        users: entries.map(e => e.user),
        contexts: entries.map(e => e.context),
        "current-context": entries[0]?.context.name ?? "",
    };
    // JSON is valid YAML, and the KubeValue provider can read it without a YAML parser.
    fs.writeFileSync(file, JSON.stringify(kubeconfig), { mode: 0o600 });
    return {
        env: { KUBECONFIG: file, DOCKER_CONFIG: dir, HELM_REGISTRY_CONFIG: path.join(dir, "registry.json") },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

const me = (lab: ResolvedLab): Owner => ({ lab: lab.name, user: currentUser() });

/** Read-only: fail early if another lab owns one of our Harvesters. */
export async function checkOwnership(lab: ResolvedLab, sessions: HarvesterSession[]): Promise<void> {
    const owner = me(lab);
    for (const { harvester: h, api, version } of sessions) {
        const current = await new HarvesterOwnerStore(api).get();
        const v = version ? ` (${version})` : "";
        if (!current) log.info(`harvester ${h.name}${v}: free`);
        else if (current.lab === owner.lab && current.user === owner.user) log.info(`harvester ${h.name}${v}: already claimed by this lab`);
        else throw new Error(`harvester "${h.name}" is in use by lab "${current.lab}" (${current.user}${current.claimedAt ? `, since ${current.claimedAt}` : ""})`);
    }
}

export async function claimHarvesters(lab: ResolvedLab, sessions: HarvesterSession[]): Promise<void> {
    const owner = me(lab);
    for (const { harvester: h, api } of sessions) {
        const result = await claim(h.name, new HarvesterOwnerStore(api), owner);
        log.info(`harvester ${h.name}: ${result === "claimed" ? "claimed for this lab" : "already claimed by this lab"}`);
    }
}

export async function releaseHarvesters(lab: ResolvedLab, sessions: HarvesterSession[], force = false): Promise<void> {
    const owner = me(lab);
    for (const { harvester: h, api } of sessions) {
        const result = await release(h.name, new HarvesterOwnerStore(api), owner, force);
        log.info(`harvester ${h.name}: ${result === "released" ? "released" : "was not claimed"}`);
    }
}
