import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HelmApp } from "@suse-tmm/common";

export type GatewayApiChannel = "standard" | "experimental";

/**
 * Gateway API CRDs.
 *
 * Neither k3s/RKE2 nor the Traefik chart ship these, so they have to be applied before any
 * controller that watches Gateway/HTTPRoute is installed. The "standard" channel carries
 * GatewayClass, Gateway, HTTPRoute and GRPCRoute; "experimental" adds TCPRoute/TLSRoute/UDPRoute.
 */
export const GatewayApiCrds = (version: string, channel: GatewayApiChannel = "standard", opts?: pulumi.ComponentResourceOptions) =>
    new k8s.yaml.v2.ConfigFile("gateway-api-crds", {
        file: `https://github.com/kubernetes-sigs/gateway-api/releases/download/${version}/${channel}-install.yaml`,
    }, opts);

export const CertManager = (version: pulumi.Input<string>, opts: pulumi.ComponentResourceOptions) => new HelmApp("cert-manager", {
        createNamespace: true,
        chart: "cert-manager",
        version: version,
        repository: "https://charts.jetstack.io",
        values: {
            crds: {
                enabled: true
            },
            dns01RecursiveNameserversOnly: true,
            dns01RecursiveNameservers: "8.8.8.8:53,1.1.1.1:53"
        },
    }, opts);

export const Traefik = (version: pulumi.Input<string>, opts?: pulumi.ComponentResourceOptions) => new HelmApp("traefik", {
        createNamespace: true,
        chart: "traefik",
        version: version,
        repository: "https://traefik.github.io/charts",
        namespace: "traefik",
        values: {
            providers: {
                kubernetesGateway: {
                    enabled: true,
                },
            },
        },
    }, opts);

export const Sprouter = (opts?: pulumi.ComponentResourceOptions) => new HelmApp("sprouter", {
        createNamespace: true,
        chart: "oci://ghcr.io/hierynomus/sprouter/charts/sprouter",
    }, opts);

export const Outrider = (opts?: pulumi.ComponentResourceOptions) => new HelmApp("outrider", {
        createNamespace: true,
        chart: "oci://ghcr.io/hierynomus/outrider/charts/outrider",
        values: {
            defaultTargetNamespace: "default",
            logLevel: "info",
        },
    }, opts);


export interface SsoOpts {
    hostname: pulumi.Input<string>;
}

export const Authentik = (version: pulumi.Input<string>, ssoOpts: SsoOpts, opts?: pulumi.ComponentResourceOptions) => new HelmApp("authentik", {
        createNamespace: true,
        chart: "authentik",
        version: version,
        repository: "https://charts.goauthentik.io",
        namespace: "authentik",
        values: {
            authentik: {
                error_reporting:{
                    enabled: false
                },
                postgresql: {
                    password: "ThisIsNotASecurePassword"
                }
            },
            server: {
                ingress: {
                    ingressClassName: "traefik",
                    enabled: true,
                    hosts: [ ssoOpts.hostname ],
                }
            },
            postgresql: {
                enabled: true,
                auth: {
                    password: "ThisIsNotASecurePassword"
                }
            }
        },
    }, opts);