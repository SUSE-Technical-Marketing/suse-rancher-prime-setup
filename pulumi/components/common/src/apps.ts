import * as pulumi from "@pulumi/pulumi";
import { HelmApp } from "./helmapp";

export const CertManager = (version: pulumi.Input<string>, opts: pulumi.ComponentResourceOptions) => new HelmApp("cert-manager", {
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
        chart: "oci://ghcr.io/hierynomus/sprouter/charts/sprouter",
    }, opts);