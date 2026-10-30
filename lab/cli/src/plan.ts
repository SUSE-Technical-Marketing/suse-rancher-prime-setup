import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_CATALOG_DIR, describeCapability, ProfileRegistry, ResolvedCatalog, ResolvedLab, VersionValue } from "@lab/schema";

/** Human-readable summary of what a lab will build, for `lab plan`. */
export function renderPlan(lab: ResolvedLab, missingSecrets: Set<string>): string {
    const out: string[] = [];
    const line = (s = "") => out.push(s);
    const profiles = (order: string[]) => order.join(" → ") || "none";

    line(`Lab ${lab.name}  (domain ${lab.domain}, TLS ${lab.tls.acme})`);

    line();
    line("Harvesters");
    if (lab.harvesters.length === 0) line("  none");
    for (const h of lab.harvesters) {
        line(`  ${h.name}  ${h.url}${h.insecure ? "  (TLS not verified)" : ""}`);
        line(`    networks: ${h.networks.map(n => `${n.name}${n.dhcp ? " (dhcp)" : ""}${n.loadBalancer ? ` (lb ${n.loadBalancer.range.join("-")})` : ""}${n.name === h.defaultNetwork ? " [default]" : ""}`).join(", ")}`);
        line(`    storage class: ${h.storageClass.name} (${h.storageClass.replicas} replica${h.storageClass.replicas > 1 ? "s" : ""})`);
        line(`    images: ${h.images.map(i => `${i.os} (${i.source.kind === "url" ? "download" : `upload ${i.source.path}`})`).join(", ") || "none"}`);
    }

    if (lab.awsSites.length > 0) {
        line();
        line("AWS sites");
        const hours = (s: number) => (s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`);
        for (const s of lab.awsSites) {
            line(`  ${s.name}  ${s.region}, VPC ${s.vpcCidr}${s.ttl ? `, meant to live ${hours(s.ttl)} (tagged, not enforced)` : ""}`);
            line(`    subnets: ${s.zones.map(z => `${z.az} ${z.cidr}`).join(", ")}`);
            const machines = new Map<string, number>();
            const add = (type: string, n: number) => machines.set(type, (machines.get(type) ?? 0) + n);
            let eks = 0;
            for (const d of lab.downstream) {
                if (d.type === "ec2" && d.site === s.name) for (const p of d.pools) add(p.instanceType, p.quantity);
                if (d.type === "eks" && d.site === s.name) {
                    eks++;
                    for (const g of d.nodeGroups) add(g.instanceType, g.quantity);
                }
            }
            if (machines.size > 0) line(`    EC2 machines (billed while the lab runs): ${[...machines].map(([type, n]) => `${n} × ${type}`).join(", ")}`);
            if (eks > 0) line(`    EKS control planes (billed per hour): ${eks}`);
        }
    }

    line();
    line("Hosts");
    if (lab.hosts.length === 0) line("  none");
    for (const h of lab.hosts) {
        if (h.kind === "harvester") {
            line(`  ${h.name}  VM on ${h.harvester}, ${h.os}, ${h.cpu} CPU / ${h.memory} / ${h.disk}, network ${h.network}`);
        } else {
            line(`  ${h.name}  existing machine ${h.user}@${h.address}, ${h.os}`);
        }
        line(`    ${h.fqdn}  profiles: ${profiles(h.profileOrder)}`);
    }

    if (lab.downstream.length > 0) {
        line();
        line("Downstream clusters");
        for (const d of lab.downstream) {
            const labels = Object.entries(d.labels).map(([k, v]) => `${k}=${v}`).join(", ");
            const annotations = Object.entries(d.annotations).map(([k, v]) => `${k}=${v}`).join(", ");
            const meta = `${labels ? `, labels ${labels}` : ""}${annotations ? `, annotations ${annotations}` : ""}`;
            if (d.type === "harvester") {
                line(`  ${d.name}  ${d.distro} on ${d.harvester}, managed by Rancher on ${d.rancher}${meta}`);
                for (const p of d.pools) {
                    line(`    pool ${p.name}: ${p.quantity} × ${p.cpu} CPU / ${p.memory} / ${p.disk}, ${p.os}, network ${p.network} [${p.roles.join(", ")}]`);
                }
            } else if (d.type === "ec2") {
                line(`  ${d.name}  ${d.distro} on EC2 (${d.site}), managed by Rancher on ${d.rancher}${meta}`);
                for (const p of d.pools) {
                    line(`    pool ${p.name}: ${p.quantity} × ${p.instanceType} / ${p.disk}, ${p.os}, zone ${p.zone} [${p.roles.join(", ")}]`);
                }
            } else if (d.type === "eks") {
                line(`  ${d.name}  EKS ${d.version} (${d.site}), created and managed by Rancher on ${d.rancher}${meta}`);
                for (const g of d.nodeGroups) {
                    const size = g.min === g.max ? `${g.quantity}` : `${g.quantity} (${g.min}–${g.max})`;
                    line(`    node group ${g.name}: ${size} × ${g.instanceType} / ${g.disk}, zones ${g.zones.join(", ")}`);
                }
            } else if (d.type === "k3k") {
                const persistence = d.persistence?.type === "ephemeral" ? "ephemeral" : `etcd on a ${d.persistence?.size ?? "default-size"} PVC (${d.persistence?.storageClass ?? "default StorageClass"})`;
                line(`  ${d.name}  k3k ${d.mode} in ${d.parent} (namespace ${d.namespace}), managed by Rancher on ${d.rancher}${meta}`);
                line(`    ${d.servers} server${d.servers > 1 ? "s" : ""}, ${d.agents} agent${d.agents === 1 ? "" : "s"}, k3s ${d.version ?? "as the parent"}, ${persistence}`);
            } else {
                line(`  ${d.name}  custom ${d.distro}, managed by Rancher on ${d.rancher}${meta}`);
                for (const n of d.nodes) line(`    node ${n.host} [${n.roles.join(", ")}]`);
            }
        }
    }

    for (const [host, f] of Object.entries(lab.fleet)) {
        line();
        line(`Fleet (Rancher on ${host})`);
        const groups = Object.keys(f.groups);
        if (groups.length > 0) line(`  groups: ${groups.join(", ")}`);
        if (f.repos.length === 0) line("  no repos");
        for (const r of f.repos) {
            line(`  repo ${r.namespace === "fleet-default" ? "" : `${r.namespace}/`}${r.name}  ${r.url}@${r.branch} ${r.paths.join(" ")}${r.target ? ` → ${r.target}` : ""}`);
        }
        for (const s of f.skipped) line(`  skipped ${s.what}: needs ${s.missing.join(", ")}`);
    }

    if (lab.objects.length > 0 || lab.skippedObjects.length > 0) {
        line();
        line("Kubernetes secrets and configmaps");
        for (const o of lab.objects) {
            const on = "host" in o.target ? o.target.host : `downstream ${o.target.downstream}`;
            line(`  ${o.kind === "Secret" ? "secret" : "configmap"} ${o.namespace}/${o.name} on ${on}  ${Object.keys(o.data).join(", ")}`);
        }
        for (const s of lab.skippedObjects) line(`  skipped ${s.what}: needs ${s.missing.join(", ")}`);
    }

    const secrets = Object.entries(lab.secrets).sort(([a], [b]) => a.localeCompare(b));
    if (secrets.length > 0) {
        line();
        line("Secrets");
        for (const [name, shape] of secrets) {
            const fields = shape === "credentials" ? " (username + password)" : typeof shape === "object" ? ` (${shape.fields.join(" + ")})` : "";
            line(`  ${missingSecrets.has(name) ? "MISSING" : "ok     "}  ${name}${fields}`);
        }
    }
    return out.join("\n");
}

/** Every profile with its rules, for `lab profiles`: the reference for lab authors. */
export function renderProfiles(registry: ProfileRegistry): string {
    const out: string[] = [];
    const describe = (c: string) => describeCapability(registry, c);
    for (const p of Object.values(registry).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push(`${p.name}`);
        out.push(`  ${p.description}`);
        const rules: string[] = [];
        if (p.provides) rules.push(`provides: ${p.provides.join(", ")}`);
        if (p.requires) rules.push(`requires on the same host: ${p.requires.map(describe).join(", ")}`);
        if (p.uses) rules.push(`uses when the host has it: ${p.uses.map(describe).join(", ")}`);
        if (p.conflicts) {
            const own = new Set([p.name, ...(p.provides ?? [])]);
            const exclusive = p.conflicts.filter(c => own.has(c));
            const others = p.conflicts.filter(c => !own.has(c));
            if (exclusive.length > 0) rules.push(`one per host: ${exclusive.map(describe).join(", ")}`);
            if (others.length > 0) rules.push(`can't share a host with: ${others.map(describe).join(", ")}`);
        }
        if (p.osFamilies) rules.push(`OS family: ${p.osFamilies.join(" or ")}`);
        if (p.hostKinds) rules.push(`runs on: ${p.hostKinds.join(" or ")} hosts`);
        if (p.hostRefs) rules.push(...p.hostRefs.map(r => `${r.field}: a host running ${describe(r.provides)}`));
        if (p.secretFields) rules.push(`secrets: ${p.secretFields.map(f => (typeof f === "string" ? f : f.field)).join(", ")}`);
        const settings = Object.keys(p.settingsSchema.properties ?? {});
        if (settings.length > 0) rules.push(`settings: ${settings.join(", ")}`);
        for (const r of rules) out.push(`  - ${r}`);
        out.push("");
    }
    return out.join("\n").trimEnd();
}


/** Where a catalog entry came from, short: `built-in`, or the file (relative to cwd or ~). */
function shortSource(source: string): string {
    if (source.startsWith(BUILTIN_CATALOG_DIR + path.sep)) return "built-in";
    const rel = path.relative(process.cwd(), source);
    if (!rel.startsWith("..")) return rel;
    return source.startsWith(os.homedir()) ? `~${source.slice(os.homedir().length)}` : source;
}

/** The effective catalog, for `lab catalog`: every entry, its value and the layer that set it. */
export function renderCatalog(catalog: ResolvedCatalog): string {
    const out: string[] = [];
    const table = (rows: [string, string, string][]) => {
        const w0 = Math.max(...rows.map(r => r[0].length)), w1 = Math.max(...rows.map(r => r[1].length));
        for (const [a, b, c] of rows) out.push(`  ${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`);
    };
    const versionText = (v: VersionValue | undefined) => v === undefined ? "-" : typeof v === "string" ? v : Object.entries(v).map(([minor, x]) => `${minor}: ${x}`).join(", ");
    for (const kind of ["KubernetesDistribution", "HelmChart", "Manifest"] as const) {
        const entries = Object.entries(catalog.components).filter(([, c]) => c.value.kind === kind).sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) continue;
        if (out.length > 0) out.push("");
        out.push(kind);
        table(entries.map(([key, { value, source }]) => [
            key,
            versionText(value.version),
            `${shortSource(source).padEnd(10)}  ${"manifest" in value ? value.manifest : "chart" in value ? `${value.repo ? `${value.repo} ` : ""}${value.chart}${value.namespace ? `  (${value.namespace})` : ""}` : ""}`,
        ]));
    }
    out.push("", "UiPlugin");
    table([
        ["repo", `${catalog.plugins.value.repo.gitRepo}@${catalog.plugins.value.repo.branch} (${catalog.plugins.value.repo.name})`, shortSource(catalog.plugins.source)],
        ["default", catalog.plugins.value.default.join(", ") || "none", shortSource(catalog.plugins.source)],
        ...Object.entries(catalog.plugins.value.versions).sort(([a], [b]) => a.localeCompare(b))
            .map(([name, v]) => [name, v, shortSource(catalog.plugins.source)] as [string, string, string]),
    ]);
    const fleetSource = (source: string) => shortSource(source.replace(/ \(catalog\.fleet\.[^)]*\)$/, ""));
    out.push("", "FleetRepo");
    table(Object.entries(catalog.fleet.repos).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value, source }]) => [
        `${name}${value.default ? " *" : ""}`,
        `${value.branch ?? "main"} ${(value.paths ?? []).join(" ")}${value.helm ? `  helm: ${value.helm.secret}` : ""}`,
        fleetSource(source),
    ]));
    out.push("  (* default: created when a rancher profile doesn't list fleet.repos)");
    for (const [section, entries] of [["SecretTemplate", catalog.secrets], ["ConfigMapTemplate", catalog.configmaps]] as const) {
        if (Object.keys(entries).length === 0) continue;
        out.push("", section);
        table(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value, source }]) => [
            name,
            `inputs: ${Object.entries(value.inputs ?? {}).map(([i, shape]) => `${i} (${shape})`).join(", ") || "none"}`,
            shortSource(source.replace(/ \(catalog\.[^)]*\)$/, "")),
        ]));
    }
    out.push("", "ClusterGroup");
    table(Object.entries(catalog.fleet.groups).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value, source }]) => [
        name, JSON.stringify(value), fleetSource(source),
    ]));
    out.push("", "OperatingSystem");
    table(Object.entries(catalog.os).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value, source }]) => [
        name,
        `${value.displayName} (${value.family})`,
        shortSource(source.replace(/ \(catalog\.os\.[^)]*\)$/, "")),
    ]));
    const d = catalog.defaults.value;
    const src = shortSource(catalog.defaults.source);
    const duration = (seconds: number) => seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
    out.push("", "Defaults");
    table([
        ["harvester.clusterNetwork", d.harvester.clusterNetwork, src],
        ["harvester.storageClass", `${d.harvester.storageClass.name} (${d.harvester.storageClass.replicas} replica${d.harvester.storageClass.replicas > 1 ? "s" : ""}) ${Object.entries(d.harvester.storageClass.parameters).map(([k, v]) => `${k}=${v}`).join(" ")}`, src],
        ...Object.entries(d.timeouts).map(([name, seconds]) => [`timeouts.${name}`, duration(seconds), src] as [string, string, string]),
    ]);
    return out.join("\n");
}
