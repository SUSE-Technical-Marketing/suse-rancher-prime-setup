import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { defaultPersonalConfigPath, formatDiagnostic, loadCatalog, loadLab, PersonalConfig, ResolvedLab } from "@lab/schema";
import { awsKeys, findAwsLeftovers } from "./aws";
import { CloudInitWatch } from "./cloudinit";
import { ConcurrentUpdateError } from "@pulumi/pulumi/automation";
import {
    checkOwnership, claimHarvesters, closeSessions, currentUser, HarvesterSession, openSessions, releaseHarvesters, writeRunFiles,
} from "./harvesters";
import { kubeconfigPath, mergeKubeconfigs, writeKubeconfig } from "./kubeconfig";
import { findLeftovers } from "./leftovers";
import { log } from "./log";
import { renderCatalog, renderPlan, renderProfiles } from "./plan";
import { buildCatalogStackPacks, stackPackProblems } from "./stackpacks";
import { resolveSecrets, ResolvedSecret } from "./secrets";
import { createOrSelectStack, selectStack, stateLocks, workspaceSettings, writeStackConfig } from "./workspace";

const USAGE = `Usage: lab <command> <lab.yaml> [options]
       lab profiles
       lab catalog [lab.yaml]
       lab stackpacks [lab.yaml]

Commands
  validate   Check the lab file, personal config and secrets; changes nothing
  plan       Show what the lab consists of; changes nothing
  preview    Show what "up" would change
  up         Create or update the lab
  destroy    Remove everything the lab created and release its Harvesters
  outputs    Show the lab's outputs (URLs, addresses)
  kubeconfig Write the lab's kubeconfig again (as "up" does): one context per cluster, next to the lab file
  release    Remove this lab's claim on its Harvesters without destroying anything
  profiles   List the host profiles and their rules (no lab file needed)
  catalog    Show the effective catalog (components, plugins, Fleet, OS profiles) and where
             each entry comes from; with a lab file, including its overrides
  stackpacks Build the catalog's StackPacks that come from source (suse-ai) into lab/.cache/stackpacks/,
             for "up" to upload; with a lab file, its own catalog's too

Options
  --config <file>       Personal config (default: $LAB_CONFIG or ~/.config/lab/config.yaml)
  --yes, -y             Don't ask for confirmation
  --refresh             Read what's really there first (preview, up): an add-on deleted or
                        changed in the Harvester UI is put back
  --show-secrets        Show secret outputs in plain text (outputs)
  --harvester <name>    Only this Harvester (release; repeatable)
  --force               Release a claim owned by another lab or user (release); build again (stackpacks)
  --check               List what the lab left on its Harvesters; destroys nothing (destroy)
`;

/**
 * Write the lab's kubeconfig from its outputs: every cluster it provisioned, one context each, the
 * Rancher host's current. Next to the lab file; where it goes from there is the user's choice.
 */
async function writeLabKubeconfig(stack: { outputs(): Promise<Record<string, { value: unknown }>> }, labFile: string, lab: string): Promise<void> {
    const outputs = await stack.outputs();
    const configs = (outputs.kubeconfigs?.value ?? {}) as Record<string, string>;
    if (Object.keys(configs).length === 0) return;
    const rancher = Object.keys((outputs.rancher?.value ?? {}) as Record<string, string>)[0];
    const file = kubeconfigPath(labFile, lab);
    writeKubeconfig(file, mergeKubeconfigs(configs, rancher));
    log.ok(`kubeconfig with ${Object.keys(configs).sort().join(", ")}: ${path.relative(process.cwd(), file) || file} (export KUBECONFIG=${file})`);
}

class UsageError extends Error {}

interface Context {
    lab: ResolvedLab;
    personal: PersonalConfig;
    personalSource: string;
}

/** Load and check everything; print diagnostics; exit on errors. */
/** The lab a command works on, for a locked state's message. */
let currentLab: string | undefined;

function load(labFile: string, configPath: string | undefined): Context {
    const result = loadLab({ labFile, personalConfig: configPath });
    for (const d of result.diagnostics.warnings) log.warn(formatDiagnostic(d).replace(/^warning: /, ""));
    for (const d of result.diagnostics.errors) log.error(formatDiagnostic(d).replace(/^error: /, ""));
    if (!result.lab || !result.personal) {
        log.error(`${result.diagnostics.errors.length} problem(s) in the lab definition`);
        process.exit(1);
    }
    currentLab = result.lab.name;
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
 * Log in to every Harvester of the lab, write this run's kubeconfig and AWS credentials, and clean
 * them up afterwards, whatever happens. `env` is what Pulumi needs to reach the Harvesters and AWS.
 */
async function withHarvesters(
    lab: ResolvedLab,
    secrets: Record<string, ResolvedSecret>,
    fn: (sessions: HarvesterSession[], env: Record<string, string>) => Promise<void>,
): Promise<void> {
    if (lab.harvesters.length === 0 && lab.awsSites.length === 0) return fn([], {});
    const sessions = await openSessions(lab, secrets);
    const run = writeRunFiles(lab.name, sessions, awsKeys(lab, secrets));
    try {
        await fn(sessions, run.env);
    } finally {
        run.cleanup();
        await closeSessions(sessions);
    }
}

const versionsOf = (sessions: HarvesterSession[]) => Object.fromEntries(sessions.map(s => [s.harvester.name, s.version]));

let pulumiStreamed = false;
// Pulumi's output and its errors as it runs: what it says before the engine starts (a locked stack)
// is only on stderr.
const pulumiOutput = {
    onOutput: (s: string) => { pulumiStreamed = true; process.stdout.write(s); },
    onError: (s: string) => process.stderr.write(s),
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
            refresh: { type: "boolean" },
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
        const { diagnostics, catalog } = loadCatalog({ personalConfig: opts.config ?? defaultPersonalConfigPath() });
        for (const d of diagnostics.items) console.error(formatDiagnostic(d));
        if (!catalog) process.exit(1);
        console.log(renderProfiles(catalog.profiles));
        return;
    }
    if (command === "catalog") {
        if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
        const { diagnostics, catalog } = loadCatalog({ labFile, personalConfig: opts.config ?? defaultPersonalConfigPath() });
        for (const d of diagnostics.items) console.error(formatDiagnostic(d));
        if (!catalog) process.exit(1);
        console.log(renderCatalog(catalog));
        return;
    }
    if (command === "stackpacks") {
        if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
        const { diagnostics, catalog } = loadCatalog({ labFile, personalConfig: opts.config ?? defaultPersonalConfigPath() });
        for (const d of diagnostics.items) console.error(formatDiagnostic(d));
        if (!catalog) process.exit(1);
        for (const line of await buildCatalogStackPacks(catalog, { force: !!opts.force })) log.ok(line);
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
            // A design for later validates; deploying it would leave out what isn't built yet.
            if (ctx.lab.planned.length > 0) {
                throw new UsageError(`${labFile} uses ${ctx.lab.planned.join(", ")}, which the engine doesn't build yet (status: planned); "${command}" needs a lab without them`);
            }
            // StackPacks built from source are built before, by "lab stackpacks": "up" uploads them.
            const unbuilt = stackPackProblems(ctx.lab);
            if (unbuilt.length > 0) throw new Error(unbuilt.join("\n"));
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
                await writeStackConfig(stack, ctx.lab, values, versionsOf(sessions), currentUser());

                if (command === "preview" || !opts.yes) {
                    log.step(`Preview of lab ${ctx.lab.name}`);
                    const watch = new CloudInitWatch();
                    await stack.preview({ ...pulumiOutput, onEvent: watch.onEvent, refresh: !!opts.refresh });
                    for (const w of watch.warnings(labFile)) log.warn(w);
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
                // With --yes there was no preview to warn in; warn after the update, also when it fails.
                const watch = new CloudInitWatch();
                try {
                    await stack.up({ ...pulumiOutput, onEvent: opts.yes ? watch.onEvent : undefined, refresh: !!opts.refresh });
                } finally {
                    for (const w of watch.warnings(labFile)) log.warn(w);
                }
                await writeLabKubeconfig(stack, labFile, ctx.lab.name);
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
                    const onHarvesters = await findLeftovers(ctx.lab, sessions);
                    const onAws = await findAwsLeftovers(ctx.lab, awsKeys(ctx.lab, values));
                    const found = [...onHarvesters.found, ...onAws.found];
                    const terminating = [...onHarvesters.terminating, ...onAws.terminating];
                    for (const l of found) console.log(l);
                    for (const l of terminating) console.log(`${l}  (still shutting down)`);
                    const where = [...sessions.map(s => s.harvester.name), ...ctx.lab.awsSites.map(s => `${s.name} (AWS ${s.region})`)];
                    if (found.length > 0) process.exitCode = 1;
                    else log.ok(`Nothing of lab ${ctx.lab.name} is left on ${where.join(", ") || "any Harvester"}${terminating.length > 0 ? " (some objects are still shutting down)" : ""}.`);
                    return;
                }
                const stack = await selectStack(ctx.lab.name, settings, env);
                if (!stack) {
                    log.info(`Lab ${ctx.lab.name} doesn't exist (never created, or already destroyed).`);
                } else {
                    if (!opts.yes && !(await confirmByName(ctx.lab.name, `This removes everything lab ${ctx.lab.name} created, on: ${[...ctx.lab.harvesters.map(h => h.name), ...ctx.lab.awsSites.map(s => `${s.name} (AWS ${s.region})`)].join(", ") || "no Harvesters"}.`))) {
                        log.info("Cancelled.");
                        return;
                    }
                    log.step(`Destroying lab ${ctx.lab.name}`);
                    await stack.destroy(pulumiOutput);
                    await stack.workspace.removeStack(ctx.lab.name);
                    // Its clusters are gone, and their credentials with them.
                    fs.rmSync(kubeconfigPath(labFile, ctx.lab.name), { force: true });
                }
                if (sessions.length > 0) {
                    log.step("Releasing Harvesters");
                    await releaseHarvesters(ctx.lab, sessions);
                }
                log.ok(`Lab ${ctx.lab.name} is gone.`);
            });
            return;
        }

        case "kubeconfig": {
            const ctx = load(labFile, configPath);
            const stack = await selectStack(ctx.lab.name, workspaceSettings());
            if (!stack) throw new Error(`lab ${ctx.lab.name} doesn't exist; run "lab up ${labFile}" first`);
            await writeLabKubeconfig(stack, labFile, ctx.lab.name);
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
    // A stack is locked while a command runs on it, and stays locked if one was stopped halfway.
    if (e instanceof ConcurrentUpdateError) {
        const locks = currentLab ? stateLocks(currentLab, workspaceSettings()) : [];
        log.error(`the state of lab ${currentLab ?? "?"} is locked: another lab command is running on it, or one was stopped halfway`);
        for (const l of locks) {
            const who = `${l.user ?? "?"}@${l.host ?? "?"}, pid ${l.pid ?? "?"}, since ${l.since ?? "?"}`;
            const state = l.running === true ? "that process still runs: let it finish"
                : l.running === false ? "that process is gone: the lock is stale, remove the file and try again"
                : "it ran on another machine: check it isn't running there, then remove the file";
            log.error(`  ${l.file} (${who}): ${state}`);
        }
        process.exit(1);
    }
    // Pulumi's own output and errors were already streamed; its error repeats all of it.
    const message = (e as Error).message;
    // Only abbreviate when Pulumi actually streamed something; otherwise the message is all there is.
    log.error(pulumiStreamed && /Command failed with exit code \d+: pulumi /.test(message) ? "Pulumi reported errors; see the output above" : message);
    process.exit(1);
});
