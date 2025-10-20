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

export const IngressNginx = (version: pulumi.Input<string>, opts?: pulumi.ComponentResourceOptions) => new HelmApp("ingress-nginx", {
        chart: "ingress-nginx",
        version: version,
        repository: "https://kubernetes.github.io/ingress-nginx",
        namespace: "ingress-nginx",
    }, opts);

export const Sprouter = (opts?: pulumi.ComponentResourceOptions) => new HelmApp("sprouter", {
        chart: "oci://ghcr.io/hierynomus/sprouter/charts/sprouter",
    }, opts);