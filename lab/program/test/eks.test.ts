import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for a lab with an EKS cluster on an AWS site, and a k3k cluster in it.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: eks-test }
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
  os: leap-16-k8s
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.admin }}" }, public-ingress: {} }
---
kind: DownstreamCluster
metadata: { name: cloud }
spec:
  type: eks
  rancher: rancher
  site: eu
  labels: { where: aws }
  logging: [ audit ]
  nodeGroups:
    - { name: general, quantity: 2, max: 4 }
    - { name: arm, quantity: 1, instanceType: m7g.large, disk: 80Gi, zones: [ b ], labels: { arch: arm } }
---
kind: DownstreamCluster
metadata: { name: tenant }
spec: { type: k3k, rancher: rancher, parent: cloud }
`;
/** No profile makes a Rancher public yet: a stub in a copy of the catalog, which the program then skips. */
function stubCatalog(): string {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lab-eks-")), "catalog");
    fs.cpSync(path.resolve(__dirname, "..", "..", "catalog"), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "profiles", "public-ingress.yaml"), "apiVersion: lab.geeko.me/v1alpha1\nkind: Profile\nmetadata: { name: public-ingress, description: test stub }\nspec: { requires: [ kubernetes ] }\n");
    return dir;
}

/** Provider inputs arrive JSON-encoded. */
const decoded = (v: unknown) => (typeof v === "string" && v.startsWith("{") ? JSON.parse(v) : v);

describe("eks clusters", () => {
    it("has Rancher create the EKS cluster in the lab's VPC, with the site's credential and tags", async () => {
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
        const tags = {
            "lab.geeko.me/lab": "eks-test", "lab.geeko.me/site": "eu", "lab.geeko.me/owner": "me@example.com",
            "lab.geeko.me/expires": "2026-10-29T18:00:00.000Z",
        };

        one("aws:ec2/vpc:Vpc", "aws/eu/vpc");
        expect(one("pulumi-nodejs:dynamic/lab:Amazonec2Credential", "rancher/aws-credential/eu")).toMatchObject({ name: "eu", region: "eu-west-1" });

        const eks = one("pulumi-nodejs:dynamic/lab:EksCluster", "downstream/cloud");
        expect(eks).toMatchObject({ name: "cloud", labels: { where: "aws" }, readySeconds: 3600 });
        expect(eks.eksConfig).toMatchObject({
            amazonCredentialSecret: "cattle-global-data:cc-x", displayName: "cloud", imported: false, region: "eu-west-1",
            kubernetesVersion: "1.34", tags, publicAccess: true, privateAccess: true, publicAccessSources: ["0.0.0.0/0"],
            loggingTypes: ["audit"], subnets: ["aws/eu/subnet-a-id", "aws/eu/subnet-b-id"], securityGroups: [],
        });
        expect(eks.eksConfig.nodeGroups).toEqual([
            expect.objectContaining({ nodegroupName: "general", version: "1.34", instanceType: "t3.large", arm: false, diskSize: 40, desiredSize: 2, minSize: 2, maxSize: 4, subnets: ["aws/eu/subnet-a-id", "aws/eu/subnet-b-id"], resourceTags: tags, ec2SshKey: "" }),
            expect.objectContaining({ nodegroupName: "arm", instanceType: "m7g.large", arm: true, diskSize: 80, desiredSize: 1, minSize: 1, maxSize: 1, subnets: ["aws/eu/subnet-b-id"], labels: { arch: "arm" } }),
        ]);

        // A k3k cluster runs in it like in any other.
        expect(one("kubernetes:k3k.io/v1beta1:Cluster", "downstream/tenant/k3k")).toBeDefined();
        expect(registered.some(r => r.name === "downstream/cloud/k3k-operator")).toBe(true);
    }, 30000);
});
