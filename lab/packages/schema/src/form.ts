// How the lab UI shows a document's fields (DESIGN.md §5.5): carried on the zod schema as
// `.meta(form({ … }))`, served to the UI in the schema's JSON Schema, and read by its SchemaForm.
// The schema says what a field is; this says how to ask for it. No imports: the UI reads the types.

/** Lists of the lab's or the catalog's names a field picks from; the UI fills them in. */
export type FormOptions =
    | "ranchers" | "harvesters" | "sites" | "parents" | "nodeHosts"
    | "distros" | "osProfiles" | "amiOs" | "networks" | "zones" | "acme";

export interface FormMeta {
    label?: string;
    /** Under the field; default the schema's description. `{…}` are filled in as in `placeholder`. */
    hint?: string;
    /**
     * Where it shows: the main grid (default), `advanced` ("More"), a section the editor names
     * (`fleet`, `tls`), or `hidden` (the editor's own control).
     */
    section?: string;
    /** A nested object whose fields sit in its parent's grid, labelled as they are (`vpc.cidr`). */
    inline?: boolean;
    /** A list of objects shown as cards (pools, node groups): what "+ add" says, and the field naming a card. */
    cards?: { add: string; title: string };
    /** Choose from one of the lab's lists. */
    options?: FormOptions;
    /** Values suggested while typing (any value goes): EC2 instance types. */
    suggestions?: string[];
    /** Like `suggestions`, from one of the lab's lists: a VM's network (a lab network, or `namespace/name`). */
    suggestionsFrom?: FormOptions;
    /** An address as you type it: checked as an IP, a CIDR, or either. */
    format?: "ip" | "cidr" | "ip-or-cidr";
    /** Labels for an enum's values. */
    optionLabels?: Record<string, string>;
    /**
     * Shown when empty: `default {defaults.aws.instanceType}`. `{…}` is a dot path into what the
     * form knows: the catalog's `defaults`, the document's `name`, the card's `item`, and the
     * editor's own (`distro`, `cnis`, `zones`, `rancherNeeds`).
     */
    placeholder?: string;
    /**
     * A control of its own: `roles` (etcd, controlplane, worker), `range` (two addresses), `secret`
     * (a secret template, or plain text unless `plain: false`), `credentials` (a secret, or username
     * and password), `awsCredentials` (a secret, or access and secret key).
     */
    widget?: "roles" | "range" | "secret" | "credentials" | "awsCredentials";
    /** For `widget: secret`: whether plain text is allowed (default yes, with a warning). */
    plain?: boolean;
    /** Only shown while a sibling field isn't this value (`persistence.type` not `ephemeral`). */
    unless?: { field: string; is: string };
    /** Only shown while a sibling field matches this pattern (`network` with a `/`: one the lab doesn't declare). */
    when?: { field: string; matches: string };
}

/** `.meta(form({ … }))` on a zod schema. */
export const form = (meta: FormMeta) => ({ form: meta });
