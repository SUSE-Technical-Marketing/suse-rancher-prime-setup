import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import { OsLayerEntry } from "./os";
import { resolveLab, ResolveResult } from "./resolve";
import { LabFile, OsProfileInput, PersonalConfig } from "./schema";

/** Default location of the personal config; `LAB_CONFIG` overrides it. */
export function defaultPersonalConfigPath(env = process.env): string {
    return env.LAB_CONFIG ?? path.join(os.homedir(), ".config", "lab", "config.yaml");
}

/** Built-in OS profiles shipped in `lab/os/`. */
export const BUILTIN_OS_DIR = path.resolve(__dirname, "..", "..", "..", "os");

function parseYaml(text: string, source: string, diags: Diagnostics): unknown {
    const doc = parseDocument(text);
    for (const err of doc.errors) {
        const line = err.linePos?.[0];
        const message = err.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "");
        diags.error(source, "", `YAML syntax error${line ? ` at line ${line.line}, column ${line.col}` : ""}: ${message}`);
    }
    return doc.errors.length > 0 ? undefined : doc.toJS();
}

function parseWith<T extends z.ZodType>(schema: T, text: string, source: string, diags: Diagnostics): z.infer<T> | undefined {
    const raw = parseYaml(text, source, diags);
    if (raw === undefined && diags.errors.length > 0) return undefined;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
        diags.addZodError(source, parsed.error);
        return undefined;
    }
    return parsed.data;
}

export function loadBuiltinOs(dir: string, diags: Diagnostics): Record<string, OsLayerEntry> {
    const result: Record<string, OsLayerEntry> = {};
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".yaml")).sort()) {
        const source = path.join(dir, file);
        const profile = parseWith(OsProfileInput, fs.readFileSync(source, "utf8"), source, diags);
        if (!profile) continue;
        const name = profile.name ?? path.basename(file, ".yaml");
        result[name] = { profile, source };
    }
    return result;
}

export interface LoadOptions {
    labFile: string;
    /** Personal config path; a missing file is fine and means "empty". */
    personalConfig?: string;
    osDir?: string;
    env?: NodeJS.ProcessEnv;
}

export interface LoadResult extends ResolveResult {
    labFile?: LabFile;
    personal?: PersonalConfig;
    personalSource: string;
}

/** Read the lab file, the personal config and the OS catalog, and resolve them into a lab. */
export function loadLab(opts: LoadOptions): LoadResult {
    const diags = new Diagnostics();
    const labSource = opts.labFile;
    const personalSource = opts.personalConfig ?? defaultPersonalConfigPath(opts.env);

    let labText: string | undefined;
    try {
        labText = fs.readFileSync(labSource, "utf8");
    } catch (e) {
        diags.error(labSource, "", `can't read lab file: ${(e as Error).message}`);
    }
    const lab = labText === undefined ? undefined : parseWith(LabFile, labText, labSource, diags);

    const personal = fs.existsSync(personalSource)
        ? parseWith(PersonalConfig, fs.readFileSync(personalSource, "utf8"), personalSource, diags)
        : PersonalConfig.parse({});

    const builtinOs = loadBuiltinOs(opts.osDir ?? BUILTIN_OS_DIR, diags);

    if (!lab || !personal || !diags.ok) return { diagnostics: diags, labFile: lab, personal, personalSource };

    const result = resolveLab({
        lab,
        labSource,
        personal,
        personalSource,
        builtinOs,
        labDir: path.dirname(path.resolve(labSource)),
        personalDir: path.dirname(path.resolve(personalSource)),
        home: os.homedir(),
        fs: { exists: p => fs.existsSync(p), read: p => fs.readFileSync(p, "utf8") },
    }, diags);
    return { ...result, labFile: lab, personal, personalSource };
}
