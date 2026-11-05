import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import type { ResolvedOs } from "./os";
import { API_VERSION, dnsLabel } from "./primitives";
import { profileTargets, type ProfileRegistry } from "./profiles";
import { RECIPE_VARIABLES, recipeVariables, renderRecipe, type RecipeVars } from "./recipe-vars";
import { AwsSiteInput, DownstreamInput, HarvesterInput, HarvesterVMSpec, MachineSpec } from "./schema";

// Recipe documents: standard building blocks for the composer's palette (DESIGN.md §17). A recipe
// is lab documents (a Rancher VM; an observability cluster; a GPU cluster, a chat cluster and the
// cluster they report to), written as in a lab file, with `${ }` variables the composer fills in
// where it's dropped (recipe-vars.ts). Dropping one adds its documents; from then on they're
// ordinary documents. The engine itself never reads them, it only checks them.

/** The lab documents a recipe can add, and their specs. */
const RECIPE_KINDS = {
    Harvester: HarvesterInput,
    AwsSite: AwsSiteInput,
    HarvesterVM: HarvesterVMSpec,
    Machine: MachineSpec,
    DownstreamCluster: DownstreamInput,
} as const;
export type RecipeKind = keyof typeof RECIPE_KINDS;

/** One of a recipe's documents, as in a lab file; its spec is checked with its variables filled in. */
export const RecipeDocument = z.strictObject({
    apiVersion: z.literal(API_VERSION),
    kind: z.enum(Object.keys(RECIPE_KINDS) as [RecipeKind, ...RecipeKind[]]),
    metadata: z.strictObject({
        /** Made unique on the board (`observability`, `observability-2`); `${ names.<this> }` is what it became. */
        name: dnsLabel,
        description: z.string().optional(),
    }),
    spec: z.record(z.string(), z.unknown()).default({}),
});
export type RecipeDocument = z.infer<typeof RecipeDocument>;

export const RecipeInput = z.strictObject({
    /** The palette's label; default the recipe's name. */
    label: z.string().min(1).optional(),
    /** Its palette icon (lucide.dev/icons); default its first document's kind's. */
    icon: z.string().min(1).optional(),
    /** What dropping it adds, in order. */
    documents: z.array(RecipeDocument).min(1),
});
export type RecipeInput = z.infer<typeof RecipeInput>;

/** Where a recipe is dropped: on a Harvester or an AWS site when it uses `drop.harvester` or `drop.site`; else the board. */
export function recipeDropsOn(recipe: Pick<RecipeInput, "documents">): ("Harvester" | "AwsSite")[] {
    const used = recipeVariables(recipe.documents);
    return [...(used.includes("drop.harvester") ? ["Harvester" as const] : []), ...(used.includes("drop.site") ? ["AwsSite" as const] : [])];
}

/** A required field left out: the composer, the personal config or the user fills it in (a Machine's address, Rancher's password). */
const missing = (issue: z.core.$ZodIssue) => issue.code === "invalid_type" && /received undefined/.test(issue.message);
const pathOf = (path: PropertyKey[]) => path.map(k => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("");

/** What a recipe's documents may name, from the rest of the catalog. */
export interface RecipeCatalog {
    profiles: ProfileRegistry;
    fleetProfiles: string[];
    stackPacks: string[];
    os: Record<string, ResolvedOs>;
}

/**
 * Recipes against the rest of the catalog: their variables are known, their documents' names are
 * unique, and each document, its variables filled with sample values, is a valid lab document whose
 * profiles, Fleet profiles, StackPacks and OS exist (profiles where they can go, their settings valid).
 */
export function checkRecipes(recipes: Record<string, { value: RecipeInput; source: string }>, c: RecipeCatalog, diags: Diagnostics): void {
    const osNames = Object.keys(c.os).sort();
    for (const [name, { value, source }] of Object.entries(recipes)) {
        // As docAt does it (documents.ts needs this module's schema first).
        const at = (field: string) => `Recipe/${name}.spec.${field}`;
        const names = value.documents.map(d => d.metadata.name);
        const sample: RecipeVars = {
            drop: { harvester: "harvester", network: "untagged", site: "site" }, rancher: "rancher", os: osNames[0],
            names: Object.fromEntries(names.map(n => [n, n])),
        };
        value.documents.forEach((doc, i) => {
            const where = (field: string) => at(`documents[${i}]${field}`);
            if (names.indexOf(doc.metadata.name) !== i) diags.error(source, where(".metadata.name"), `${doc.metadata.name} is the name of another of its documents`);
            for (const v of recipeVariables(doc.spec)) {
                const known = RECIPE_VARIABLES.includes(v) || (v.startsWith("names.") && names.includes(v.slice("names.".length)));
                if (!known) diags.error(source, where(".spec"), `unknown variable \${ ${v} }; known: ${[...new Set([...RECIPE_VARIABLES, ...names.map(n => `names.${n}`)])].join(", ")}`);
            }
            const spec = renderRecipe(doc.spec, sample);
            const parsed = RECIPE_KINDS[doc.kind].safeParse(spec);
            if (!parsed.success) {
                for (const issue of parsed.error.issues.filter(x => !missing(x))) diags.error(source, where(`.spec${pathOf(issue.path)}`), issue.message);
            }
            const s = spec as { os?: unknown; profiles?: Record<string, unknown>; fleetProfiles?: Record<string, unknown>; stackPacks?: unknown[]; pools?: { os?: unknown }[] };
            for (const o of [s.os, ...(s.pools ?? []).map(p => p.os)]) {
                if (typeof o === "string" && !c.os[o]) diags.error(source, where(".spec"), `unknown OS "${o}"; known: ${osNames.join(", ")}`);
            }
            const target = doc.kind === "DownstreamCluster" ? "cluster" : doc.kind === "Harvester" ? "harvester" : "host";
            for (const [p, settings] of Object.entries(s.profiles ?? {})) {
                const def = c.profiles[p];
                if (!def) {
                    diags.error(source, where(".spec.profiles"), `unknown profile "${p}"; known: ${Object.keys(c.profiles).sort().join(", ")}`);
                    continue;
                }
                if (!profileTargets(def).includes(target)) diags.error(source, where(`.spec.profiles.${p}`), `doesn't go on a ${doc.kind}`);
                const hostKind = doc.kind === "Machine" ? "ssh" : "harvester";
                if (target === "host" && def.hostKinds && !def.hostKinds.includes(hostKind)) diags.error(source, where(`.spec.profiles.${p}`), `only runs on ${def.hostKinds.join(", ")} hosts, not a ${doc.kind}`);
                const ok = def.settings.safeParse(settings ?? {});
                if (!ok.success) for (const issue of ok.error.issues.filter(x => !missing(x))) diags.error(source, where(`.spec.profiles.${p}${pathOf(issue.path)}`), issue.message);
            }
            for (const f of Object.keys(s.fleetProfiles ?? {})) {
                if (!c.fleetProfiles.includes(f)) diags.error(source, where(`.spec.fleetProfiles.${f}`), `unknown Fleet profile "${f}"`);
            }
            (s.stackPacks ?? []).forEach((sp, j) => {
                if (typeof sp === "string" && !c.stackPacks.includes(sp)) diags.error(source, where(`.spec.stackPacks[${j}]`), `no StackPack "${sp}"`);
            });
        });
    }
}
