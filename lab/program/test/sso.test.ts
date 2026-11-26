import { describe, expect, it } from "vitest";
import { runProgram, catalogChartVersion } from "./run-program";

// The whole program under Pulumi's mocks: Keycloak on the Rancher host (with a realm and a client for
// Rancher), and Rancher's auth provider pointed at it.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: sso-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec: { url: https://hv.example.com, credentials: "{{ secrets.hv }}" }
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles:
    k3s: {}
    cert-manager: {}
    sprouter: {}
    traefik: {}
    outrider: {}
    rancher: { adminPassword: "{{ secrets.admin }}" }
    keycloak:
      adminPassword: "{{ secrets.kc }}"
      users: [ ann ]
      userPassword: "{{ secrets.users }}"
      rancherUrl: https://rancher.rancher.lab.example.com
      clientSecret: "{{ secrets.client }}"
    rancher-sso: { issuer: https://keycloak.rancher.lab.example.com/realms/lab, clientSecret: "{{ secrets.client }}" }
`;

describe("Keycloak and Rancher SSO", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);

    it("installs Keycloak from its chart, at the host's ingress", async () => {
        registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" }, kc: "kc-pass", users: "user-pass", client: "client-secret" },
        });
        const release = registered.find(r => /keycloak\/.*chart$/.test(r.name) || r.name === "rancher/keycloak/chart")!;
        expect(release, registered.map(r => r.name).filter(n => n.includes("keycloak")).join(", ")).toBeDefined();
        expect(release.inputs).toMatchObject({ chart: "keycloakx", namespace: "keycloak", version: catalogChartVersion("keycloakx") });
        expect(release.inputs.values.ingress.rules[0].host).toBe("keycloak.rancher.lab.example.com");
    }, 30000);

    it("makes the realm in a Secret, with the user and the Rancher client", () => {
        const realm = registered.find(r => r.type === "kubernetes:core/v1:Secret" && r.inputs.metadata?.name === "keycloak-realm")!;
        expect(realm).toBeDefined();
        const json = JSON.stringify(realm.inputs.stringData);
        expect(json).toContain("ann");
        expect(json).toContain("verify-auth");
    });

    it("makes Rancher's Keycloak auth provider and its client secret", () => {
        const auth = registered.find(r => r.inputs?.kind === "AuthConfig" && r.inputs.metadata?.name === "keycloakoidc")!;
        expect(auth).toBeDefined();
        expect(auth.inputs).toMatchObject({ enabled: true, clientId: "rancher", issuer: "https://keycloak.rancher.lab.example.com/realms/lab" });
        expect(registered.find(r => r.inputs?.metadata?.name === "keycloakoidcconfig-clientsecret")).toBeDefined();
    });
});
