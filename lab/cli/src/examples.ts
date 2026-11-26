import * as fs from "node:fs";
import * as path from "node:path";

/** The example labs shipped with the tool: generic, ready to copy (`lab examples`). */
export const EXAMPLES_DIR = path.resolve(__dirname, "..", "..", "examples");

export interface Example {
    name: string;
    /** The first line of the file, a comment: what the lab builds. */
    summary: string;
    file: string;
}

/** Every `<name>.yaml` in `dir`, by name; the summary is the file's first comment line. */
export function listExamples(dir = EXAMPLES_DIR): Example[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith(".yaml")).sort().map(f => {
        const file = path.join(dir, f);
        const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
        return { name: f.replace(/\.yaml$/, ""), summary: first.startsWith("#") ? first.replace(/^#\s*/, "") : "", file };
    });
}

/** The example called `name`; throws with the known names when there is none. */
export function findExample(name: string, dir = EXAMPLES_DIR): Example {
    const all = listExamples(dir);
    const hit = all.find(e => e.name === name);
    if (!hit) throw new Error(`no example "${name}"; known: ${all.map(e => e.name).join(", ") || "none"}`);
    return hit;
}

export function renderExamples(examples: Example[]): string {
    const width = Math.max(0, ...examples.map(e => e.name.length));
    return examples.map(e => `${e.name.padEnd(width)}  ${e.summary}`).join("\n");
}
