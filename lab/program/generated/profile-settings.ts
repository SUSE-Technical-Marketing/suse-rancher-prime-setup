// Generated from the Profile documents in lab/catalog/ by `mise run profile-types`. Don't edit.
import type { Credentials } from "@lab/schema";

/** Settings of the `ai-factory` profile: SUSE AI Factory on Rancher: its operator and UI extension, logged in to the registries its blueprints install from */
export type AiFactorySettings = {
    version?: string;
    /** SUSE Application Collection login (dp.apps.rancher.io), e.g. "{{ secrets.appco }}" */
    applicationCollection: Credentials;
    /** SUSE registry login for the AI charts (registry.suse.com/ai), e.g. "{{ secrets.scc }}" */
    suseRegistry: Credentials;
    /** NVIDIA NGC API key, for NIM blueprints, e.g. "{{ secrets.nvidia }}" */
    nvidia?: Credentials;
    /** Extra Helm values for aif-operator, merged over the engine's */
    values?: Record<string, unknown>;
};

/** Settings of the `cert-manager` profile: cert-manager with Let's Encrypt issuers (Cloudflare DNS-01) and a wildcard certificate for the host */
export type CertManagerSettings = {
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `harvester-cloud-provider` profile: Harvester cloud provider: LoadBalancer services get an address from the network's Harvester load-balancer pool (instead of ServiceLB) */
export type HarvesterCloudProviderSettings = {
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `hauler` profile: Hauler registry as systemd services, its store synced from HaulManifests; TLS from lego (DNS-01) */
export type HaulerSettings = {
    version?: string;
    manifests: string[];
    port: number;
    fileserverPort?: number;
};

/** Settings of the `hauler-chart` profile: Hauler registry on Kubernetes (the official chart), its store synced from HaulManifests by a Job */
export type HaulerChartSettings = {
    version?: string;
    manifests: string[];
    storage: string;
    fileserver: boolean;
    values?: Record<string, unknown>;
};

/** Settings of the `k3s` profile: Single-node k3s cluster on the host */
export type K3sSettings = {
    /** k3s version; default from this file */
    version?: string;
};

/** Settings of the `metallb` profile: MetalLB in L2 mode: LoadBalancer services get an address from a range on the host's network (instead of ServiceLB) */
export type MetallbSettings = {
    /** Ranges or CIDRs it hands out, on the host's network and outside its DHCP range, e.g. 10.29.20.221-10.29.20.230 */
    addresses: string[];
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `mlm-client` profile: Registers the host with a Multi-Linux Manager server in the lab */
export type MlmClientSettings = {
    /** The host running mlm-server */
    server: string;
    activationKey?: string;
};

/** Settings of the `mlm-server` profile: SUSE Multi-Linux Manager server (containers on SL Micro, installed with mgradm) */
export type MlmServerSettings = {
    version?: string;
    adminPassword: string;
    products: "auto" | string[];
};

/** Settings of the `outrider` profile: Outrider: propagates annotated secrets to downstream clusters */
export type OutriderSettings = {
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `rancher` profile: Rancher Manager on the host's Kubernetes cluster, with UI plugins and Fleet */
export type RancherSettings = {
    version?: string;
    /** First label of Rancher's name: <hostname>.<host>.<domain> */
    hostname: string;
    adminPassword: string;
    /** How Rancher is reached: gateway (a Gateway and HTTPRoutes), ingress (an Ingress), or auto: gateway when the host has the Gateway API */
    exposure: "auto" | "gateway" | "ingress";
    /** UI plugins by name (versions from the catalog), or name -> version; default the catalog's set */
    plugins?: string[] | Record<string, string>;
    /** Install Liz, Rancher's AI assistant */
    liz?: boolean;
    /** Extra Helm values, merged over the engine's */
    values?: Record<string, unknown>;
    /** Rancher settings by name (management.cattle.io Settings), e.g. ui-banners; server-url is the lab's */
    settings?: Record<string, string>;
    /** Feature flags by name, merged over the default; false turns one off */
    features: Record<string, boolean>;
    /** GitRepos and HelmOps from the catalog; their secrets come from the lab's inputs */
    fleet?: {
        /** GitRepos by catalog name; default the repos with default: true */
        repos?: string[];
        /** HelmOps by catalog name; default the HelmOps with default: true */
        helmOps?: string[];
    };
};

/** Settings of the `rke2` profile: Single-node RKE2 cluster on the host */
export type Rke2Settings = {
    /** RKE2 version; default from this file */
    version?: string;
};

/** Settings of the `sprouter` profile: Sprouter: copies labelled secrets (the wildcard certificate) into every namespace */
export type SprouterSettings = {
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `traefik` profile: Traefik ingress controller with the Gateway API CRDs and its Gateway provider */
export type TraefikSettings = {
    version?: string;
    gatewayApi?: {
        version?: string;
        channel: "standard" | "experimental";
    };
    values?: Record<string, unknown>;
};

/** Profile name -> its settings. */
export interface ProfileSettings {
    "ai-factory": AiFactorySettings;
    "cert-manager": CertManagerSettings;
    "harvester-cloud-provider": HarvesterCloudProviderSettings;
    "hauler": HaulerSettings;
    "hauler-chart": HaulerChartSettings;
    "k3s": K3sSettings;
    "metallb": MetallbSettings;
    "mlm-client": MlmClientSettings;
    "mlm-server": MlmServerSettings;
    "outrider": OutriderSettings;
    "rancher": RancherSettings;
    "rke2": Rke2Settings;
    "sprouter": SprouterSettings;
    "traefik": TraefikSettings;
}
