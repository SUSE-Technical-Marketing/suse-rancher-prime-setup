// A Recipe's own variables (DESIGN.md §17): `${ drop.harvester }` and the like in its documents,
// filled in by the composer where the recipe is dropped. Not `{{ }}`: that's a lab template
// (`{{ lab.domain }}`), copied into the lab as it is. No dependencies: the lab UI uses this too.

/** What the composer knows when a recipe is dropped. */
export interface RecipeVars {
    /** Where it was dropped: a Harvester (and its network lane), an AWS site; on the board, the first one. */
    drop: { harvester?: string; network?: string; site?: string };
    /** The board's Rancher: the first host with the rancher profile. */
    rancher?: string;
    /** The composer's default OS. */
    os?: string;
    /** The recipe's documents by their name in it, as they're named on the board (made unique). */
    names: Record<string, string>;
}

/** The variables a recipe may use, but `names.<document>`. */
export const RECIPE_VARIABLES = ["drop.harvester", "drop.network", "drop.site", "rancher", "os"];

const WHOLE = /^\s*\$\{\s*([\w.-]+)\s*\}\s*$/;
const ANY = /\$\{\s*([\w.-]+)\s*\}/g;

const lookup = (vars: RecipeVars, name: string): string | undefined => {
    const [head, ...rest] = name.split(".");
    if (head === "names") return vars.names[rest.join(".")];
    if (head === "drop") return vars.drop[rest.join(".") as keyof RecipeVars["drop"]];
    return rest.length === 0 ? (vars as unknown as Record<string, string | undefined>)[head] : undefined;
};

/**
 * A recipe's document (or any part of it) with its variables filled in. A string that's only one
 * variable takes its value; when that's unset (no Harvester on the board), its key or list item is
 * left out. One inside other text is replaced by its value, or nothing.
 */
export function renderRecipe<T>(value: T, vars: RecipeVars): T {
    const render = (v: unknown): unknown => {
        if (typeof v === "string") {
            const whole = WHOLE.exec(v);
            if (whole) return lookup(vars, whole[1]);
            return v.replace(ANY, (_m, name: string) => lookup(vars, name) ?? "");
        }
        if (Array.isArray(v)) return v.map(render).filter(x => x !== undefined);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x)]).filter(([, x]) => x !== undefined));
        return v;
    };
    return render(value) as T;
}

/** The variables a recipe's document uses, in order of first use. */
export function recipeVariables(value: unknown): string[] {
    const found = new Set<string>();
    const walk = (v: unknown) => {
        if (typeof v === "string") for (const m of v.matchAll(ANY)) found.add(m[1]);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
    return [...found];
}
