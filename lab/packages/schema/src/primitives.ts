import { z } from "zod";

// Names that end up as Kubernetes object names, DNS labels and Pulumi stack names.
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;
const QUANTITY = /^[1-9][0-9]*(Mi|Gi|Ti)$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
export const CIDR = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)\/([0-9]|[12][0-9]|3[0-2])$/;
export const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export const dnsLabel = z.string().regex(DNS_LABEL, "must be a lowercase DNS label (a-z, 0-9, '-', max 63 chars)");
/** OS profile names may contain dots (`sl-micro-6.1`); they become parts of Kubernetes object names. */
export const osName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,61}[a-z0-9])?$/, "must be lowercase letters, digits, '-' and '.'");
export const dnsName = z.string().regex(DNS_NAME, "must be a lowercase DNS name");
export const quantity = z.string().regex(QUANTITY, "must be a size like 8Gi, 512Mi or 1Ti");
export const ipv4 = z.string().regex(IPV4, "must be an IPv4 address");
/** A duration like `90s`, `15m` or `2h`. */
export const duration = z.string().regex(/^[1-9][0-9]*(s|m|h)$/, "must be a duration like 90s, 15m or 2h");

/** What the engine waits for, by name (a Defaults document's `timeouts`, DESIGN.md §17). */
export const TIMEOUTS = [
    "harvesterAddon", "image", "vmStart", "vmAddress", "cloudInit", "loadBalancerCleanup",
    "kubernetesApi", "resourceReady", "certificate",
    "rancherReady", "uiPlugin", "harvesterImport", "clusterRegistration", "downstreamReady", "downstreamDelete",
    "helmJobWatch",
] as const;
export type TimeoutName = (typeof TIMEOUTS)[number];

/** Seconds in a (checked) duration. */
export function durationSeconds(d: string): number {
    return Number(d.slice(0, -1)) * { s: 1, m: 60, h: 3600 }[d.slice(-1) as "s" | "m" | "h"];
}

/** `{ file: path }` — non-secret file contents, read when the lab is loaded. */
export const FileRef = z.strictObject({ file: z.string().min(1) });
export type FileRef = z.infer<typeof FileRef>;

/**
 * A secret: a template over the personal config's `secrets` ("{{ secrets['ssh-key'] }}"), or a plain
 * value, which triggers a warning when written in a lab file (secrets.ts).
 */
export const secretOrString = z.string().min(1);

/** One secret holding a username and password ("{{ secrets.harbor }}"), or the fields themselves. */
export const Credentials = z.union([
    secretOrString,
    z.strictObject({ username: z.string().min(1), password: secretOrString }),
]);
export type Credentials = z.infer<typeof Credentials>;

export const ImageSource = z.union([
    z.strictObject({ url: z.url() }),
    z.strictObject({ file: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof ImageSource>;


export const OS_FAMILIES = ["suse", "rhel", "debian"] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

/** Extra Helm values for a chart profile, merged over the engine's (DESIGN.md §16.2). */
export const chartValues = z.record(z.string(), z.unknown()).optional();
