import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import type { ResolvedOs } from "./os";
import { dnsLabel, osName, quantity } from "./primitives";
import type { ProfileRegistry } from "./profiles";

// HostRecipe documents: standard hosts for the composer's palette (a Rancher VM, a registry). Dropping
// one adds a HarvesterVM or Machine document with the recipe's size, OS and profiles; from then on
// it's an ordinary host. The engine itself never reads them.

export const HostRecipeInput = z.strictObject({
    /** The palette's label; default the recipe's name. */
    label: z.string().min(1).optional(),
    /** Its palette icon (lucide.dev/icons); default the host kind's. */
    icon: z.string().min(1).optional(),
    /** What it adds: a VM on a Harvester, or an existing machine. */
    kind: z.enum(["HarvesterVM", "Machine"]).default("HarvesterVM"),
    /** The new host's name, made unique (`rancher`, `rancher-2`); default the recipe's name. */
    name: dnsLabel.optional(),
    /** Fields of the new host: a VM's size, the OS (default the composer's), its profiles and their settings. */
    host: z.strictObject({
        cpu: z.int().min(1).optional(),
        memory: quantity.optional(),
        disk: quantity.optional(),
        os: osName.optional(),
        /** Settings a profile needs that the personal config can fill in (Rancher's admin password) may be left out. */
        profiles: z.record(z.string().min(1), z.record(z.string(), z.unknown())).default({}),
    }).default({ profiles: {} }),
});
export type HostRecipeInput = z.infer<typeof HostRecipeInput>;

/** A setting left out: the composer fills it in (from the personal config), or the user does. */
const missing = (issue: z.core.$ZodIssue) => issue.code === "invalid_type" && /received undefined/.test(issue.message);

/**
 * Recipes against the rest of the catalog: their profiles exist and can go on their kind of host,
 * the settings they give are valid, their OS exists, and a Machine gets no VM size.
 */
export function checkRecipes(
    recipes: Record<string, { value: HostRecipeInput; source: string }>, profiles: ProfileRegistry,
    os: Record<string, ResolvedOs>, diags: Diagnostics,
): void {
    for (const [name, { value, source }] of Object.entries(recipes)) {
        // As docAt does it (documents.ts needs this module's schema first).
        const at = (field: string) => `HostRecipe/${name}.spec.${field}`;
        const { kind, host } = value;
        if (kind === "Machine") {
            for (const f of ["cpu", "memory", "disk"] as const) if (host[f] !== undefined) diags.error(source, at(`host.${f}`), "doesn't apply to a Machine");
        }
        if (host.os !== undefined && !os[host.os]) diags.error(source, at("host.os"), `unknown OS "${host.os}"; known: ${Object.keys(os).sort().join(", ")}`);
        const hostKind = kind === "Machine" ? "ssh" : "harvester";
        for (const [p, settings] of Object.entries(host.profiles)) {
            const def = profiles[p];
            if (!def) {
                diags.error(source, at("host.profiles"), `unknown profile "${p}"; known: ${Object.keys(profiles).sort().join(", ")}`);
                continue;
            }
            if (def.hostKinds && !def.hostKinds.includes(hostKind)) diags.error(source, at(`host.profiles.${p}`), `only runs on ${def.hostKinds.join(", ")} hosts, not a ${kind}`);
            const parsed = def.settings.safeParse(settings ?? {});
            if (parsed.success) continue;
            for (const issue of parsed.error.issues.filter(i => !missing(i))) {
                diags.error(source, at(`host.profiles.${p}${issue.path.map(k => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("")}`), issue.message);
            }
        }
    }
}
