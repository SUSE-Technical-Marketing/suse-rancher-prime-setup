import { z } from "zod";

export interface Diagnostic {
    level: "error" | "warning";
    /** Which file the problem is in: the lab file, the personal config, or an OS profile file. */
    source: string;
    /** Dotted path to the field, e.g. `hosts.rancher.profiles.rancher`. Empty for the whole file. */
    path: string;
    message: string;
}

export class Diagnostics {
    readonly items: Diagnostic[] = [];

    error(source: string, path: string, message: string): void {
        this.items.push({ level: "error", source, path, message });
    }

    warning(source: string, path: string, message: string): void {
        this.items.push({ level: "warning", source, path, message });
    }

    get errors(): Diagnostic[] {
        return this.items.filter(d => d.level === "error");
    }

    get warnings(): Diagnostic[] {
        return this.items.filter(d => d.level === "warning");
    }

    get ok(): boolean {
        return this.errors.length === 0;
    }

    addZodError(source: string, error: z.ZodError, prefix: readonly PropertyKey[] = []): void {
        for (const issue of error.issues) {
            const path = joinPath([...prefix, ...issue.path]);
            if (issue.code === "unrecognized_keys") {
                for (const key of issue.keys) {
                    this.error(source, joinPath([...prefix, ...issue.path, key]), `unknown field "${key}"`);
                }
            } else if (issue.code === "invalid_union") {
                // Every alternative failing only because the value is absent means the field is missing.
                const missing = issue.errors.length > 0 && issue.errors.every(alt =>
                    alt.length > 0 && alt.every(i => i.code === "invalid_type" && i.path.length === 0 && i.message.endsWith("received undefined")));
                // One alternative fits the value's shape and fails further in: its errors are the useful ones.
                const fitting = issue.errors.filter(alt => alt.length > 0 && alt.every(i => i.path.length > 0));
                if (!missing && fitting.length === 1) {
                    this.addZodError(source, new z.ZodError(fitting[0]), [...prefix, ...issue.path]);
                    continue;
                }
                this.error(source, path, missing ? "required" : "doesn't match any of the allowed forms");
            } else if (issue.code === "invalid_key") {
                // A record key failing its schema: say why, not just "Invalid key in record".
                this.error(source, path, `key ${issue.issues[0]?.message ?? "is invalid"}`);
            } else if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
                this.error(source, path, "required");
            } else {
                this.error(source, path, issue.message);
            }
        }
    }
}

export function joinPath(parts: readonly PropertyKey[]): string {
    return parts.reduce<string>((acc, part) => {
        if (typeof part === "number") return `${acc}[${part}]`;
        return acc ? `${acc}.${String(part)}` : String(part);
    }, "");
}

export function formatDiagnostic(d: Diagnostic): string {
    const where = d.path ? `${d.source}: ${d.path}` : d.source;
    return `${d.level === "error" ? "error" : "warning"}: ${where}: ${d.message}`;
}
