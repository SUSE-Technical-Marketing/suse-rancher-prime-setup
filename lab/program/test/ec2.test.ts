import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for a lab with an EC2 cluster on an AWS site.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: ec2-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt, email: a@example.com, cloudflare: "{{ secrets.cf }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  networks:
    vlans: [ { id: 20, dhcp: { cidr: 10.0.20.0/24, gateway: 10.0.20.1, range: [ 10.0.20.100, 10.0.20.150 ] } } ]
    default: vlan20
---
kind: AwsSite
metadata: { name: eu }
spec: { region: eu-west-1, credentials: "{{ secrets.aws }}", ttl: 8h }
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.admin }}" }, public-ingress: {} }
---
kind: DownstreamCluster
metadata: { name: cloud }
spec:
  type: ec2
  rancher: rancher
  site: eu
  labels: { where: aws }
  pools:
    - { name: cp, quantity: 1, roles: [ etcd, controlplane ], os: ubuntu-24.04 }
    - { name: workers, quantity: 2, roles: [ worker ], os: rocky-9, instanceType: m6i.xlarge, disk: 100Gi, zone: b }
`;

/** No profile makes a Rancher public yet: a stub in a copy of the catalog, which the program then skips. */
function stubCatalog(): string {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lab-ec2-")), "catalog");
    fs.cpSync(path.resolve(__dirname, "..", "..", "catalog"), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "profiles", "public-ingress.yaml"), "apiVersion: lab.geeko.me/v1alpha1\nkind: Profile\nmetadata: { name: public-ingress, description: test stub }\nspec: { requires: [ kubernetes ] }\n");
    return dir;
}

/** Provider inputs arrive JSON-encoded. */
const decoded = (v: unknown) => (typeof v === "string" && v.startsWith("{") ? JSON.parse(v) : v);

describe("ec2 clusters", () => {
    it("creates the lab's VPC on the site and has Rancher's node driver put the machines in it", async () => {
        const registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cf: "c", aws: { accessKey: "AK", secretKey: "SK" } },
            catalogDir: stubCatalog(),
            tweak: lab => { for (const h of lab.hosts) h.profileOrder = h.profileOrder.filter(p => p !== "public-ingress"); },
        });
        const one = (type: string, name: string) => {
            const r = registered.find(x => x.type === type && x.name === name);
            if (!r) throw new Error(`no ${type} ${name}; registered: ${registered.map(x => `${x.type} ${x.name}`).join(", ")}`);
            return r.inputs;
        };

        // Keys come from the run's credentials file, by profile; every resource gets the lab's tags.
        const provider = one("pulumi:providers:aws", "eu");
        expect(provider).toMatchObject({ region: "eu-west-1", profile: "lab-eu" });
        expect(provider).not.toHaveProperty("accessKey");
        const tags = {
            "lab.geeko.me/lab": "ec2-test", "lab.geeko.me/site": "eu", "lab.geeko.me/owner": "me@example.com",
            "lab.geeko.me/expires": "2026-10-29T18:00:00.000Z",
        };
        expect(decoded(provider.defaultTags)).toEqual({ tags });

        expect(one("aws:ec2/vpc:Vpc", "aws/eu/vpc")).toMatchObject({ cidrBlock: "10.100.0.0/16", enableDnsHostnames: true });
        expect(one("aws:ec2/subnet:Subnet", "aws/eu/subnet-a")).toMatchObject({ availabilityZone: "eu-west-1a", cidrBlock: "10.100.0.0/20", mapPublicIpOnLaunch: true });
        expect(one("aws:ec2/subnet:Subnet", "aws/eu/subnet-b")).toMatchObject({ availabilityZone: "eu-west-1b", cidrBlock: "10.100.16.0/20" });
        expect(one("aws:ec2/securityGroup:SecurityGroup", "aws/eu/nodes")).toMatchObject({ name: "ec2-test-nodes" });

        // The credential Rancher uses for the site; the AMIs looked up once per OS and kept.
        expect(one("pulumi-nodejs:dynamic/lab:Amazonec2Credential", "rancher/aws-credential/eu")).toMatchObject({ name: "eu", region: "eu-west-1" });
        expect(one("pulumi-nodejs:dynamic/lab:Pinned", "aws/eu/ami/rocky-9")).toMatchObject({ value: "ami-792107900819" });

        const config = (pool: string) => one("kubernetes:rke-machine-config.cattle.io/v1:Amazonec2Config", `downstream/cloud/${pool}`);
        expect(config("cp")).toMatchObject({
            metadata: { name: "cloud-cp", namespace: "fleet-default" },
            region: "eu-west-1", zone: "a", vpcId: "aws/eu/vpc-id", subnetId: "aws/eu/subnet-a-id",
            securityGroup: ["ec2-test-nodes"], securityGroupReadonly: true,
            instanceType: "t3.large", rootSize: "40", volumeType: "gp3", ami: "ami-099720109477", sshUser: "ubuntu",
            httpTokens: "required",
        });
        expect(config("workers")).toMatchObject({ zone: "b", subnetId: "aws/eu/subnet-b-id", instanceType: "m6i.xlarge", rootSize: "100", sshUser: "rocky" });
        expect(Object.fromEntries(chunks(config("cp").tags.split(",")))).toEqual(tags);

        const cluster = one("kubernetes:provisioning.cattle.io/v1:Cluster", "downstream/cloud/cluster");
        expect(cluster.metadata.labels).toEqual({ where: "aws" });
        expect(cluster.spec.cloudCredentialSecretName).toBe("cattle-global-data:cc-x");
        expect(cluster.spec.rkeConfig.machinePools.map((p: any) => [p.name, p.machineConfigRef.kind, p.quantity])).toEqual([["cp", "Amazonec2Config", 1], ["workers", "Amazonec2Config", 2]]);
    }, 30000);
});

function chunks(list: string[]): [string, string][] {
    const out: [string, string][] = [];
    for (let i = 0; i < list.length; i += 2) out.push([list[i], list[i + 1]]);
    return out;
}
