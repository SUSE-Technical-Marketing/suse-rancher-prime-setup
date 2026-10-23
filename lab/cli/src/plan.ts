import { describeCapability, PROFILES, ResolvedLab } from "@lab/schema";

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
            if (d.type === "harvester") {
                line(`  ${d.name}  ${d.distro} on ${d.harvester}, managed by Rancher on ${d.rancher}${labels ? `, labels ${labels}` : ""}`);
                for (const p of d.pools) {
                    line(`    pool ${p.name}: ${p.quantity} × ${p.cpu} CPU / ${p.memory} / ${p.disk}, ${p.os}, network ${p.network} [${p.roles.join(", ")}]`);
                }
            } else {
                line(`  ${d.name}  custom ${d.distro}, managed by Rancher on ${d.rancher}${labels ? `, labels ${labels}` : ""}`);
                for (const n of d.nodes) line(`    node ${n.host} [${n.roles.join(", ")}]`);
            }
        }
    }

    const secrets = Object.entries(lab.secrets).sort(([a], [b]) => a.localeCompare(b));
    if (secrets.length > 0) {
        line();
        line("Secrets");
        for (const [name, shape] of secrets) {
            line(`  ${missingSecrets.has(name) ? "MISSING" : "ok     "}  ${name}${shape === "credentials" ? " (username + password)" : ""}`);
        }
    }
    return out.join("\n");
}

/** Every profile with its rules, for `lab profiles`: the reference for lab authors. */
export function renderProfiles(): string {
    const out: string[] = [];
    for (const p of PROFILES) {
        out.push(`${p.name}`);
        out.push(`  ${p.description}`);
        const rules: string[] = [];
        if ("provides" in p && p.provides) rules.push(`provides: ${p.provides.join(", ")}`);
        if ("requires" in p && p.requires) rules.push(`requires on the same host: ${p.requires.map(describeCapability).join(", ")}`);
        if ("conflicts" in p && p.conflicts) {
            const own = new Set([p.name, ...("provides" in p && p.provides ? p.provides : [])]);
            const exclusive = p.conflicts.filter(c => own.has(c));
            const others = p.conflicts.filter(c => !own.has(c));
            if (exclusive.length > 0) rules.push(`one per host: ${exclusive.map(describeCapability).join(", ")}`);
            if (others.length > 0) rules.push(`can't share a host with: ${others.map(describeCapability).join(", ")}`);
        }
        if ("osFamilies" in p && p.osFamilies) rules.push(`OS family: ${p.osFamilies.join(" or ")}`);
        if ("hostRefs" in p && p.hostRefs) rules.push(...p.hostRefs.map(r => `${r.field}: a host running ${describeCapability(r.provides)}`));
        if ("secretFields" in p && p.secretFields) rules.push(`secrets: ${p.secretFields.join(", ")}`);
        for (const r of rules) out.push(`  - ${r}`);
        out.push("");
    }
    return out.join("\n").trimEnd();
}
