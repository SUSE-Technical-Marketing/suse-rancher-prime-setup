import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { defaultPersonalConfigPath, formatDiagnostic, loadLab, PersonalConfig, ResolvedLab } from "@lab/schema";
import {
    checkOwnership, claimHarvesters, closeSessions, HarvesterSession, openSessions, releaseHarvesters, writeRunFiles,
} from "./harvesters";
import { findLeftovers } from "./leftovers";
import { log } from "./log";
import { renderPlan, renderProfiles } from "./plan";
import { resolveSecrets, ResolvedSecret } from "./secrets";
import { createOrSelectStack, selectStack, workspaceSettings, writeStackConfig } from "./workspace";

const USAGE = `Usage: lab <command> <lab.yaml> [options]
       lab profiles

Commands
  validate   Check the lab file, personal config and secrets; changes nothing
  plan       Show what the lab consists of; changes nothing
  preview    Show what "up" would change
  up         Create or update the lab
  destroy    Remove everything the lab created and release its Harvesters
  outputs    Show the lab's outputs (URLs, addresses)
  release    Remove this lab's claim on its Harvesters without destroying anything
  profiles   List the host profiles and their rules (no lab file needed)

Options
  --config <file>       Personal config (default: $LAB_CONFIG or ~/.config/lab/config.yaml)
  --yes, -y             Don't ask for confirmation
  --show-secrets        Show secret outputs in plain text (outputs)
  --harvester <name>    Only this Harvester (release; repeatable)
  --force               Release a claim owned by another lab or user (release)
  --check               List what the lab left on its Harvesters; destroys nothing (destroy)
`;

class UsageError extends Error {}

interface Context {
    lab: ResolvedLab;
    personal: PersonalConfig;
    personalSource: string;
}

/** Load and check everything; print diagnostics; exit on errors. */
function load(labFile: string, configPath: string | undefined): Context {
    const result = loadLab({ labFile, personalConfig: configPath });
    for (const d of result.diagnostics.warnings) log.warn(formatDiagnostic(d).replace(/^warning: /, ""));
    for (const d of result.diagnostics.errors) log.error(formatDiagnostic(d).replace(/^error: /, ""));
    if (!result.lab || !result.personal) {
        log.error(`${result.diagnostics.errors.length} problem(s) in the lab definition`);
        process.exit(1);
    }
    return { lab: result.lab, personal: result.personal, personalSource: result.personalSource };
}

function secretsFor(ctx: Context, strict: boolean): { values: Record<string, ResolvedSecret>; missing: Set<string> } {
    const { values, problems } = resolveSecrets(ctx.lab.secrets, ctx.personal.secrets, { configDir: path.dirname(ctx.personalSource) });
    for (const p of problems) (strict ? log.error : log.warn)(p);
    if (strict && problems.length > 0) process.exit(1);
    const missing = new Set(Object.keys(ctx.lab.secrets).filter(n => !(n in values)));
    return { values, missing };
}

async function confirm(question: string): Promise<boolean> {
    if (!process.stdin.isTTY) throw new UsageError("not running interactively; pass --yes to confirm");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
        rl.close();
    }
}

async function confirmByName(name: string, action: string): Promise<boolean> {
    if (!process.stdin.isTTY) throw new UsageError("not running interactively; pass --yes to confirm");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return (await rl.question(`${action}\nType the lab name (${name}) to confirm: `)).trim() === name;
    } finally {
        rl.close();
    }
}

/**
 * Log in to every Harvester of the lab, write this run's kubeconfig, and clean both up afterwards,
 * whatever happens. `env` is what Pulumi needs to reach the Harvesters.
 */
async function withHarvesters(
    lab: ResolvedLab,
    secrets: Record<string, ResolvedSecret>,
    fn: (sessions: HarvesterSession[], env: Record<string, string>) => Promise<void>,
): Promise<void> {
    if (lab.harvesters.length === 0) return fn([], {});
    const sessions = await openSessions(lab, secrets);
    const run = writeRunFiles(lab.name, sessions);
    try {
        await fn(sessions, run.env);
    } finally {
        run.cleanup();
        await closeSessions(sessions);
    }
}

const versionsOf = (sessions: HarvesterSession[]) => Object.fromEntries(sessions.map(s => [s.harvester.name, s.version]));

const pulumiOutput = {
    onOutput: (s: string) => process.stdout.write(s),
    color: (process.stdout.isTTY ? "always" : "never") as "always" | "never",
};

async function main(argv: string[]): Promise<void> {
    const { values: opts, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            config: { type: "string" },
            yes: { type: "boolean", short: "y" },
            "show-secrets": { type: "boolean" },
            harvester: { type: "string", multiple: true },
            force: { type: "boolean" },
            check: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, labFile, ...rest] = positionals;
    if (opts.help || !command) {
        process.stderr.write(USAGE);
        return;
    }
    if (command === "profiles") {
        console.log(renderProfiles());
        return;
    }
    if (!labFile) throw new UsageError(`"${command}" needs a lab file`);
    if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
    const configPath = opts.config ?? defaultPersonalConfigPath();

    switch (command) {
        case "validate": {
            const ctx = load(labFile, configPath);
            const { missing } = secretsFor(ctx, false);
            log.ok(`${labFile}: valid${missing.size > 0 ? `, but ${missing.size} secret(s) are not set yet` : ""}`);
            return;
        }

        case "plan": {
            const ctx = load(labFile, configPath);
            const { missing } = secretsFor(ctx, false);
            console.log(renderPlan(ctx.lab, missing));
            return;
        }

        case "preview":
        case "up": {
            const ctx = load(labFile, configPath);
            const { values } = secretsFor(ctx, true);
            const settings = workspaceSettings();
            if (settings.createdPassphrase) {
                log.warn(`created ${settings.createdPassphrase}; it encrypts the secrets in your lab state. Keep it: without it you can't update or destroy your labs.`);
            }
            await withHarvesters(ctx.lab, values, async (sessions, env) => {
                if (sessions.length > 0) {
                    log.step("Checking Harvesters");
                    await checkOwnership(ctx.lab, sessions);
                }
                const stack = await createOrSelectStack(ctx.lab, settings, env);
                await writeStackConfig(stack, ctx.lab, values, versionsOf(sessions));

                if (command === "preview" || !opts.yes) {
                    log.step(`Preview of lab ${ctx.lab.name}`);
                    await stack.preview(pulumiOutput);
                    if (command === "preview") return;
                    if (!(await confirm(`Apply these changes to lab ${ctx.lab.name}?`))) {
                        log.info("Cancelled.");
                        return;
                    }
                }
                if (sessions.length > 0) {
                    log.step("Claiming Harvesters");
                    await claimHarvesters(ctx.lab, sessions);
                }
                log.step(`Updating lab ${ctx.lab.name}`);
                await stack.up(pulumiOutput);
                log.ok(`Lab ${ctx.lab.name} is up. Run "lab outputs ${labFile}" to see its addresses.`);
            });
            return;
        }

        case "destroy": {
            const ctx = load(labFile, configPath);
            const { values } = secretsFor(ctx, true);
            const settings = workspaceSettings();
            await withHarvesters(ctx.lab, values, async (sessions, env) => {
                if (opts.check) {
                    const { found, terminating } = await findLeftovers(ctx.lab, sessions);
                    for (const l of found) console.log(l);
                    for (const l of terminating) console.log(`${l}  (still shutting down)`);
                    if (found.length > 0) process.exitCode = 1;
                    else log.ok(`Nothing of lab ${ctx.lab.name} is left on ${sessions.map(s => s.harvester.name).join(", ") || "any Harvester"}${terminating.length > 0 ? " (some objects are still shutting down)" : ""}.`);
                    return;
                }
                const stack = await selectStack(ctx.lab.name, settings, env);
                if (!stack) {
                    log.info(`Lab ${ctx.lab.name} doesn't exist (never created, or already destroyed).`);
                } else {
                    if (!opts.yes && !(await confirmByName(ctx.lab.name, `This removes everything lab ${ctx.lab.name} created, on: ${ctx.lab.harvesters.map(h => h.name).join(", ") || "no Harvesters"}.`))) {
                        log.info("Cancelled.");
                        return;
                    }
                    log.step(`Destroying lab ${ctx.lab.name}`);
                    await stack.destroy(pulumiOutput);
                    await stack.workspace.removeStack(ctx.lab.name);
                }
                if (sessions.length > 0) {
                    log.step("Releasing Harvesters");
                    await releaseHarvesters(ctx.lab, sessions);
                }
                log.ok(`Lab ${ctx.lab.name} is gone.`);
            });
            return;
        }

        case "outputs": {
            const ctx = load(labFile, configPath);
            const stack = await selectStack(ctx.lab.name, workspaceSettings());
            if (!stack) throw new Error(`lab ${ctx.lab.name} doesn't exist; run "lab up ${labFile}" first`);
            const outputs = await stack.outputs();
            for (const [key, { value, secret }] of Object.entries(outputs)) {
                const shown = secret && !opts["show-secrets"] ? "[secret]  (use --show-secrets)" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
                console.log(`${key}: ${shown}`);
            }
            return;
        }

        case "release": {
            const ctx = load(labFile, configPath);
            const { values } = secretsFor(ctx, true);
            if (opts.force && !opts.yes && !(await confirm("Release the claim even if another lab or user owns it?"))) {
                log.info("Cancelled.");
                return;
            }
            const sessions = await openSessions(ctx.lab, values, opts.harvester);
            try {
                await releaseHarvesters(ctx.lab, sessions, opts.force);
            } finally {
                await closeSessions(sessions);
            }
            return;
        }

        default:
            throw new UsageError(`unknown command "${command}"`);
    }
}

main(process.argv.slice(2)).catch(e => {
    if (e instanceof UsageError) {
        log.error(e.message);
        process.stderr.write(`\n${USAGE}`);
        process.exit(2);
    }
    // Pulumi's own output was already streamed; its error repeats all of it.
    const message = (e as Error).message;
    log.error(/Command failed with exit code \d+: pulumi /.test(message) ? "Pulumi reported errors; see the output above" : message);
    process.exit(1);
});
