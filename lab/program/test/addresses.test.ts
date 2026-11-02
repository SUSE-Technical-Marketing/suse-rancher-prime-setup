import { describe, expect, it } from "vitest";
import { addresses, runProgram } from "./run-program";

// The whole program under Pulumi's mocks for a lab with every profile that has code beyond a host
// build: the DNS controller, SUSE Observability agents (host, cluster, Harvester) and Landlock (VM,
// machine, cluster). The snapshot holds every resource's address (its URN's parent chain, type and
// name): a change to it replaces resources in running labs, so it must be deliberate (and carry
// aliases).

const AGENT = "suse-observability-agent: { observer: obs }";
const POOL = "pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ]";
const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: addresses-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
  inputs:
    suse-observability-license: "{{ secrets.observability.license }}"
    suse-observability-token: "{{ secrets.observability.token }}"
    suse-observability-password: "{{ secrets.observability.password }}"
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  networks:
    vlans: [ { id: 20, dhcp: { cidr: 10.0.20.0/24, gateway: 10.0.20.1, range: [ 10.0.20.100, 10.0.20.150 ] } } ]
    default: vlan20
  profiles:
    ${AGENT}
    harvester-dns-controller: { backend: routeros, host: 10.0.0.1, credentials: "{{ secrets.router }}" }
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, outrider: {}, rancher: { adminPassword: "{{ secrets.admin }}" }, ${AGENT} }
---
kind: HarvesterVM
metadata: { name: sandbox }
spec: { harvester: hv, os: leap-16, profiles: { rke2: {}, landlock: {} } }
---
kind: Machine
metadata: { name: box }
spec: { address: 10.0.30.5, os: leap-16, profiles: { k3s: {}, landlock: {} } }
---
kind: DownstreamCluster
metadata: { name: obs }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, fleetProfiles: { storage: {}, observability: {} } }
---
kind: DownstreamCluster
metadata: { name: apps }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, profiles: { landlock: {}, sprouter: {}, ${AGENT} } }
`;

describe("resource addresses", () => {
    it("stay as they are", async () => {
        await runProgram(LAB, {
            secrets: {
                "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" }, router: { username: "admin", password: "r" },
                observability: { license: "l", token: "t", password: "pw" },
            },
        });
        expect([...addresses].sort()).toMatchSnapshot();
    }, 30000);
});
