import { describe, expect, it } from "vitest";
import {
    HarvesterVMSpec, HOST_TRAITS, hostSite, hostTraits, loadLab, MachineSpec, ResolvedHost, ResolvedLab, SITE_TRAITS, sitesOf, sshUserOf, VM_SPECS, VmCommon,
} from "../src";
import { labFiles, labsFixture } from "./labs-fixture";

const fixture = labsFixture();
const load = (file: string): ResolvedLab => loadLab({ labFile: fixture.labPath(file), personalConfig: fixture.personalConfig() }).lab!;

describe("host traits", () => {
    it("a Harvester VM is created and bootstraps through user data", () => {
        expect(hostTraits({ kind: "harvester" })).toEqual({ created: true, bootstrap: "user-data" });
    });

    it("an existing machine is not created and bootstraps over SSH", () => {
        expect(hostTraits({ kind: "ssh" })).toEqual({ created: false, bootstrap: "ssh" });
    });

    it("a host the lab doesn't create can only be bootstrapped over SSH", () => {
        // Nothing can hand user data to a machine that already runs.
        for (const [kind, traits] of Object.entries(HOST_TRAITS)) {
            if (!traits.created) expect(traits.bootstrap, kind).toBe("ssh");
        }
    });

    it("every host kind of every example lab has traits", () => {
        const kinds = new Set<string>();
        for (const file of labFiles) for (const h of load(file).hosts) kinds.add(h.kind);
        expect([...kinds].sort()).toEqual(["harvester", "ssh"]);
        for (const kind of kinds) expect(HOST_TRAITS).toHaveProperty(kind);
    });
});

describe("hostSite", () => {
    const lab = () => load("rancher-custom-edge.yaml");

    it("is the Harvester a VM runs on", () => {
        const vm = lab().hosts.find(h => h.kind === "harvester")!;
        expect(hostSite(vm)).toEqual({ kind: "harvester", name: (vm as Extract<ResolvedHost, { kind: "harvester" }>).harvester });
    });

    it("is nothing for an existing machine", () => {
        expect(hostSite(lab().hosts.find(h => h.kind === "ssh")!)).toBeUndefined();
    });

    it("always names a site the lab declares", () => {
        for (const file of labFiles) {
            const l = load(file);
            const declared = sitesOf(l).map(s => `${s.kind}/${s.name}`);
            for (const h of l.hosts) {
                const site = hostSite(h);
                if (site) expect(declared, `${file}: ${h.name}`).toContain(`${site.kind}/${site.name}`);
            }
        }
    });
});

describe("sshUserOf", () => {
    it("is the machine's own user for an existing machine, the lab's for a VM it created", () => {
        const lab = load("rancher-custom-edge.yaml");
        expect(sshUserOf(lab.hosts.find(h => h.kind === "ssh")!, lab)).toBe("root");
        expect(sshUserOf(lab.hosts.find(h => h.kind === "harvester")!, lab)).toBe(lab.ssh!.user);
    });
});

describe("sites", () => {
    it("lists Harvesters first, then AWS sites, each in the lab's order", () => {
        const lab = { harvesters: [{ name: "b" }, { name: "a" }], awsSites: [{ name: "z" }] } as unknown as ResolvedLab;
        expect(sitesOf(lab)).toEqual([{ kind: "harvester", name: "b" }, { kind: "harvester", name: "a" }, { kind: "aws", name: "z" }]);
    });

    it("lists no site for a lab with only existing machines", () => {
        expect(sitesOf(load("asgard-m4-machines.yaml")).filter(s => s.kind === "harvester")).toEqual([]);
    });

    it("a Harvester is exclusive (its add-ons and default storage class belong to one lab), an AWS site is shared (a VPC per lab)", () => {
        expect(SITE_TRAITS.harvester.sharing).toBe("exclusive");
        expect(SITE_TRAITS.aws.sharing).toBe("shared");
    });
});

describe("VmCommon", () => {
    it.each(Object.entries(VM_SPECS))("%s has every field of VmCommon, as the same schema", (_kind, spec) => {
        for (const [field, schema] of Object.entries(VmCommon.shape)) {
            expect(spec.shape, field).toHaveProperty(field);
            expect((spec.shape as Record<string, unknown>)[field], `${field} is VmCommon's`).toBe(schema);
        }
    });

    it("is what a HarvesterVM and a Machine share: the OS and what runs on it", () => {
        for (const field of ["os", "profiles", "secrets", "configmaps", "charts"]) {
            expect(HarvesterVMSpec.shape, field).toHaveProperty(field);
            expect(MachineSpec.shape, field).toHaveProperty(field);
        }
    });

    it("keeps a backend's own fields out of it", () => {
        expect(Object.keys(VmCommon.shape).sort()).toEqual(["charts", "configmaps", "cpu", "disk", "fqdn", "memory", "os", "profiles", "secrets"]);
        expect(VmCommon.shape).not.toHaveProperty("network");
        expect(VmCommon.shape).not.toHaveProperty("harvester");
    });

    it("a HarvesterVM adds only its own fields", () => {
        const own = Object.keys(HarvesterVMSpec.shape).filter(k => !(k in VmCommon.shape)).sort();
        expect(own).toEqual(["harvester", "ip", "gateway", "dns", "macAddress", "network"].sort());
    });
});
