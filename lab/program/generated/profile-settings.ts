// Generated from the Profile documents in lab/catalog/ by `mise run profile-types`. Don't edit.
import type { Credentials } from "@lab/schema";

/** Settings of the `ai-demos` profile: AI demos (github.com/wiredquill/ai-demos) as SUSE AI Factory blueprints: their chart repositories, and the blueprints */
export type AiDemosSettings = {
    /** the demos' git repository (a fork, to try changes) */
    repo: string;
    /** the branch whose catalog/blueprints holds the blueprints */
    blueprintsBranch: string;
    /** the branch with the packaged charts (index.yaml and .tgz files) of the wiredquill-ai-demos ClusterRepo */
    chartsBranch: string;
    /** the branch with the community charts of the wiredquill-upstream ClusterRepo */
    upstreamBranch: string;
};

/** Settings of the `ai-factory` profile: SUSE AI Factory on Rancher: its operator and UI extension, logged in to the registries its blueprints install from */
export type AiFactorySettings = {
    version?: string;
    /** SUSE Application Collection login (dp.apps.rancher.io) */
    applicationCollection: Credentials;
    /** SUSE registry login for the AI charts (registry.suse.com/ai) */
    suseRegistry: Credentials;
    /** NVIDIA NGC API key, for NIM blueprints */
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

/** Settings of the `harvester-dns-controller` profile: DNS records for the lab's VMs and load balancers on your router (RouterOS or GL.Inet), by the harvester-dns-controller add-on */
export type HarvesterDnsControllerSettings = {
    /** the router's kind */
    backend: "routeros" | "glinet";
    /** the router's address or name */
    host: string;
    /** the router's login (GL.Inet only uses the password) */
    credentials: Credentials;
    /** TTL of every record: 15m, 1h, 1d (default the chart's, 15m) */
    ttl?: string;
    /** reach the router's API over HTTPS (default plain HTTP) */
    useTls?: boolean;
    /** check the router's certificate (off for a self-signed one) */
    tlsVerify?: boolean;
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

/** Settings of the `landlock` profile: Landlock on every node: the kernel's sandboxing LSM, which OpenShell's agent sandboxes need */
export type LandlockSettings = Record<string, never>;

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

/** Settings of the `open-webui` profile: Open WebUI chatting with an OpenAI-compatible API (a vLLM), traced into SUSE Observability when the cluster has the opentelemetry profile */
export type OpenWebuiSettings = {
    /** the OpenAI-compatible API it chats with (a vLLM's router: http://<host>:<port>/v1) */
    openaiUrl: string;
    /** its key (vLLM takes any) */
    openaiApiKey: string;
    /** the model a new chat starts with (vLLM's name for it: the Hugging Face model) */
    defaultModel?: string;
    title: string;
    /** its ingress's host; default open-webui.<cluster>.<domain> */
    host?: string;
    /** its volumes' storage class; default the cluster's */
    storageClass?: string;
    /** SUSE AI's Open WebUI filter in a pipelines server, for SUSE Observability's GenAI views */
    pipelines: boolean;
    /** the SUSE AI Observability Extension release the filter is from */
    filterVersion: string;
    version?: string;
    values?: Record<string, unknown>;
};

/** Settings of the `opentelemetry` profile: SUSE AI observability for the cluster: the OpenTelemetry Operator and SUSE AI's collector, sending traces, metrics and topology to SUSE Observability on another cluster */
export type OpentelemetrySettings = {
    /** the downstream cluster running SUSE Observability that it sends to */
    observer: string;
    /** a SUSE Observability API key (service token) to send with; default the instance's bootstrap token */
    apiKey: string;
    /** the cluster's name in SUSE Observability (as its agent's clusterName); default the cluster's */
    clusterName?: string;
    /** the namespace of the AI workloads; SUSE AI components are reported in it */
    suseAiNamespace: string;
    /** the collector's image: SUSE AI's (amd64 only), or otel/opentelemetry-collector-contrib on arm64 with topology off */
    collectorImage: string;
    /** send the GenAI topology with SUSE's exporter (only in SUSE AI's collector) */
    topology: boolean;
    /** the collector image's tag (SUSE AI's follows the upstream collector's versions) */
    collectorVersion: string;
    /** a downstream cluster whose collector (serveGateway) this one sends its spans to, unsampled, for the service graph (otlp-gateway.<cluster>.<domain>:443) */
    gateway?: string;
    /** be the gateway: take other clusters' spans at otlp-gateway.<cluster>.<domain>:443 (the cluster's ingress and wildcard certificate; open to whoever reaches it) and send their calls to SUSE Observability as the service graph */
    serveGateway: boolean;
    /** a vLLM not deployed by the vllm profile, to scrape (its engines, label serving-engine, port 80) */
    vllm?: {
        namespace: string;
    };
    /** a Qdrant in the AI namespace, to scrape */
    qdrant?: {
        service: string;
    };
    /** a Milvus in the AI namespace, to scrape */
    milvus?: {
        service: string;
    };
    /** an OpenSearch to poll for its cluster health (Service opensearch-cluster-master-headless) */
    opensearch?: {
        namespace: string;
        credentials: Credentials;
    };
    version?: string;
    values?: Record<string, unknown>;
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

/** Settings of the `suse-observability-agent` profile: SUSE Observability's agent, registered with the instance on another cluster of the lab */
export type SuseObservabilityAgentSettings = {
    /** the downstream cluster running SUSE Observability that this agent reports to */
    observer: string;
    /** the instance's bootstrap service token (not the admin password), to register the agent with */
    adminToken: string;
    /** its name in SUSE Observability; default: the host's, cluster's or Harvester's name */
    clusterName?: string;
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

/** Settings of the `vllm` profile: vLLM serving one model on the cluster's NVIDIA GPUs, an OpenAI-compatible API (after SUSE AI Factory's vLLM guide) */
export type VllmSettings = {
    /** the Hugging Face model to serve (e.g. RadixArk/Qwen3.8-27B-NVFP4) */
    model: string;
    /** the model's name in the stack (its engine's Deployment) */
    name: string;
    imageRegistry: string;
    imageRepository: string;
    imageTag: string;
    requestCPU: number;
    requestMemory: string;
    requestGPU: number;
    /** shared memory for the engine */
    shmSize: string;
    /** the longest context it serves (its KV cache is sized for it); default the model's own */
    maxModelLen?: number;
    /** the most requests it serves at once */
    maxNumSeqs: number;
    /** the most tokens in one batch (with chunked prefill, a long prompt is split by it) */
    maxNumBatchedTokens: number;
    /** the share of the GPU's memory it takes (on a DGX Spark, of the memory it shares with the CPU) */
    gpuMemoryUtilization: number;
    tensorParallelSize: number;
    /** the KV cache's type (auto, fp8, …) */
    kvCacheDtype: string;
    enableChunkedPrefill: boolean;
    enablePrefixCaching: boolean;
    asyncScheduling: boolean;
    /** run the model's own code from Hugging Face */
    trustRemoteCode: boolean;
    /** how it loads the weights (e.g. instanttensor, in the DGX Spark build) */
    loadFormat?: string;
    /** speculative decoding, as vLLM's --speculative-config ({ method: dflash, model: …, num_speculative_tokens: 8 }) */
    speculativeConfig?: Record<string, never>;
    /** the model's reasoning parser (e.g. qwen3) */
    reasoningParser?: string;
    /** the model's tool-call parser (e.g. qwen3_xml); turns on automatic tool choice */
    toolCallParser?: string;
    /** a volume for the model's cache (e.g. 100Gi); without one, every restart downloads it again */
    pvcStorage?: string;
    storageClass?: string;
    /** a directory on the node for the model and the compiled kernels (e.g. /var/lib/vllm-cache): kept over restarts without a storage class */
    hostCache?: string;
    /** free the page cache and the kernel's reclaimable memory before the engine starts (privileged): for shared CPU/GPU memory, as on a DGX Spark */
    dropCaches: boolean;
    /** how long its first start may take (downloading the model, compiling kernels) before it is restarted */
    startupMinutes: number;
    /** the router's OpenAI API on this port of every node (http://<node>:<port>/v1), for other clusters */
    nodePort?: number;
    /** an OTLP gRPC endpoint for the engine's request spans (vLLM's --otlp-traces-endpoint, e.g. the cluster's collector); with the opentelemetry profile's gateway, the service graph shows who calls it */
    otlpTracesEndpoint?: string;
    /** the GPU Operator's runtime class */
    runtimeClassName: string;
    /** a Hugging Face token, for gated models */
    hfToken?: string;
    version?: string;
    values?: Record<string, unknown>;
};

/** Profile name -> its settings. */
export interface ProfileSettings {
    "ai-demos": AiDemosSettings;
    "ai-factory": AiFactorySettings;
    "cert-manager": CertManagerSettings;
    "harvester-cloud-provider": HarvesterCloudProviderSettings;
    "harvester-dns-controller": HarvesterDnsControllerSettings;
    "hauler": HaulerSettings;
    "hauler-chart": HaulerChartSettings;
    "k3s": K3sSettings;
    "landlock": LandlockSettings;
    "metallb": MetallbSettings;
    "mlm-client": MlmClientSettings;
    "mlm-server": MlmServerSettings;
    "open-webui": OpenWebuiSettings;
    "opentelemetry": OpentelemetrySettings;
    "outrider": OutriderSettings;
    "rancher": RancherSettings;
    "rke2": Rke2Settings;
    "sprouter": SprouterSettings;
    "suse-observability-agent": SuseObservabilityAgentSettings;
    "traefik": TraefikSettings;
    "vllm": VllmSettings;
}
