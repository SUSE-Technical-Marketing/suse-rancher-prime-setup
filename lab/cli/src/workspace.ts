import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalWorkspace, Stack } from "@pulumi/pulumi/automation";
import { ResolvedLab } from "@lab/schema";
import { ResolvedSecret } from "./secrets";

/** The Pulumi project the CLI drives. */
export const PROGRAM_DIR = path.resolve(__dirname, "..", "..", "program");

export interface WorkspaceSettings {
    backendUrl: string;
    passphraseFile?: string;
    /** Set when the CLI just created a passphrase file, so it can tell the user to keep it. */
    createdPassphrase?: string;
}

/**
 * State lives in a local file backend (LAB_STATE_URL overrides). The passphrase that encrypts
 * secrets in state comes from PULUMI_CONFIG_PASSPHRASE(_FILE), or from a file the CLI creates once.
 */
export function workspaceSettings(env = process.env): WorkspaceSettings {
    let backendUrl = env.LAB_STATE_URL;
    if (!backendUrl) {
        const dir = path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "lab", "state");
        fs.mkdirSync(dir, { recursive: true });
        backendUrl = `file://${dir}`;
    }

    if (env.PULUMI_CONFIG_PASSPHRASE !== undefined) return { backendUrl };
    if (env.PULUMI_CONFIG_PASSPHRASE_FILE) return { backendUrl, passphraseFile: env.PULUMI_CONFIG_PASSPHRASE_FILE };

    const passphraseFile = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "lab", "passphrase");
    if (fs.existsSync(passphraseFile)) return { backendUrl, passphraseFile };
    fs.mkdirSync(path.dirname(passphraseFile), { recursive: true });
    fs.writeFileSync(passphraseFile, randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
    return { backendUrl, passphraseFile, createdPassphrase: passphraseFile };
}

function envVars(settings: WorkspaceSettings, extra: Record<string, string>): Record<string, string> {
    return {
        PULUMI_BACKEND_URL: settings.backendUrl,
        PULUMI_SKIP_UPDATE_CHECKS: "true",
        ...(settings.passphraseFile ? { PULUMI_CONFIG_PASSPHRASE_FILE: settings.passphraseFile } : {}),
        ...extra,
    };
}

/** `extra` carries per-run environment, such as the KUBECONFIG with this run's Harvester tokens. */
export async function createOrSelectStack(lab: ResolvedLab, settings: WorkspaceSettings, extra: Record<string, string> = {}): Promise<Stack> {
    return LocalWorkspace.createOrSelectStack({ stackName: lab.name, workDir: PROGRAM_DIR }, { envVars: envVars(settings, extra) });
}

/** Select an existing stack; undefined if the lab was never created (or already destroyed). */
export async function selectStack(labName: string, settings: WorkspaceSettings, extra: Record<string, string> = {}): Promise<Stack | undefined> {
    const ws = await LocalWorkspace.create({ workDir: PROGRAM_DIR, envVars: envVars(settings, extra) });
    const stacks = await ws.listStacks();
    if (!stacks.some(s => s.name === labName)) return undefined;
    return LocalWorkspace.selectStack({ stackName: labName, workDir: PROGRAM_DIR }, { envVars: envVars(settings, extra) });
}

/** Hand the resolved lab, the secret values and facts about the Harvesters to the program. */
export async function writeStackConfig(
    stack: Stack,
    lab: ResolvedLab,
    secrets: Record<string, ResolvedSecret>,
    harvesterVersions: Record<string, string | undefined>,
): Promise<void> {
    await stack.setAllConfig({
        "lab:resolved": { value: JSON.stringify(lab) },
        "lab:secrets": { value: JSON.stringify(secrets), secret: true },
        "lab:harvesterVersions": { value: JSON.stringify(harvesterVersions) },
    });
}
