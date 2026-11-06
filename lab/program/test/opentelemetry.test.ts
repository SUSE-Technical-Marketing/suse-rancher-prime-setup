import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks: the opentelemetry ChartProfile on a downstream cluster,
// sending to SUSE Observability on cluster obs. Its Operator chart comes from Application Collection
// (a registry login), after what Fleet puts on the cluster (cert-manager, the pull secret).

const POOL = "pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ]";
const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: otel-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
  inputs:
    appco: "{{ secrets.appco }}"
    suse-observability-token: "{{ secrets.observability.token }}"
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
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.admin }}" } }
---
kind: DownstreamCluster
metadata: { name: obs }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, fleetProfiles: { storage: {}, observability: {} }, stackPacks: [ open-telemetry, suse-ai ], profiles: { opentelemetry: { observer: obs, serveGateway: true } } }
---
kind: DownstreamCluster
metadata: { name: apps }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, profiles: { opentelemetry: { observer: obs } } }
---
kind: DownstreamCluster
metadata: { name: chat }
spec:
  type: harvester
  rancher: rancher
  harvester: hv
  ${POOL}
  profiles:
    opentelemetry: { observer: obs, collectorImage: docker.io/otel/opentelemetry-collector-contrib, topology: false, gateway: obs }
    open-webui: { openaiUrl: "http://spark.lab.example.com:30080/v1", defaultModel: Qwen/Qwen3-8B }
---
kind: DownstreamCluster
metadata: { name: spark }
spec:
  type: harvester
  rancher: rancher
  harvester: hv
  ${POOL}
  fleetProfiles: { gpu-operator: {} }
  profiles:
    vllm:
      model: RadixArk/Qwen3.8-27B-NVFP4
      imageRegistry: docker.io
      imageRepository: eugr/spark-vllm
      imageTag: latest
      maxModelLen: 262144
      loadFormat: instanttensor
      speculativeConfig: { method: dflash, model: z-lab/Qwen3.8-27B-DFlash2, num_speculative_tokens: 8 }
      reasoningParser: qwen3
      toolCallParser: qwen3_xml
      nodePort: 30080
      hostCache: /var/lib/vllm-cache
      dropCaches: true
---
kind: DownstreamCluster
metadata: { name: gpu }
spec:
  type: harvester
  rancher: rancher
  harvester: hv
  ${POOL}
  fleetProfiles: { gpu-operator: {} }
  profiles:
    vllm: { model: Qwen/Qwen3-8B, pvcStorage: 50Gi, otlpTracesEndpoint: "http://opentelemetry-collector.observability.svc.cluster.local:4317" }
    opentelemetry: { observer: obs, collectorVersion: 0.160.1, qdrant: { service: qdrant } }
`;

describe("OpenTelemetry on a downstream cluster", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);

    it("installs the Operator logged in to Application Collection, once Fleet's cert-manager and pull secret are there", async () => {
        registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" }, appco: { username: "me", password: "pw" }, observability: { token: "t" } },
        });
        const chart = find("downstream/apps/opentelemetry/chart")!;
        expect(chart.inputs).toMatchObject({ chart: "oci://dp.apps.rancher.io/charts/opentelemetry-operator", namespace: "opentelemetry-operator" });
        // Secret, as its password is: the mocks show it wrapped.
        expect(chart.inputs.repositoryOpts.value ?? chart.inputs.repositoryOpts).toEqual({ username: "me", password: "pw" });
        const waits = registered.filter(r => r.name.startsWith("downstream/apps/opentelemetry/opentelemetry-operator/wait-")).map(r => r.inputs.path);
        expect(waits.sort()).toEqual([
            "/api/v1/namespaces/cattle-system/secrets/application-collection",
            "/api/v1/namespaces/cattle-system/secrets/suse-registry",
            "/apis/apps/v1/namespaces/cert-manager/deployments/cert-manager-webhook",
        ]);
    }, 30000);

    it("creates SUSE AI's collector sending to the observer's OTLP and topology endpoints with the API key", () => {
        const collector = find("downstream/apps/opentelemetry/collector")!.inputs;
        expect(collector.spec.image).toBe("registry.suse.com/ai/containers/suse-ai-opentelemetry-collector:0.149.0");
        expect(collector.spec.env).toEqual([{ name: "K8S_CLUSTER_NAME", value: "apps" }, { name: "SUSE_AI_NAMESPACE", value: "suse-ai" }]);
        const { exporters, receivers, service } = collector.spec.config;
        expect(exporters.otlp.endpoint).toBe("otlp-observability.obs.lab.example.com:443");
        expect(exporters.otlp.tls).toEqual({ insecure_skip_verify: false });
        // Before 0.160 the topology exporter names the cluster with instance_url.
        expect(exporters.topology).toMatchObject({ endpoint: "https://observability.obs.lab.example.com", instance_url: "${env:K8S_CLUSTER_NAME}" });
        expect(exporters.topology.cluster_name).toBeUndefined();
        // Nothing optional on a cluster without GPUs, vLLM or vector databases.
        expect(Object.keys(receivers)).toEqual(["otlp"]);
        expect(Object.keys(service.pipelines).filter(p => /gpu|vllm|qdrant/.test(p))).toEqual([]);
        expect(JSON.stringify(find("downstream/apps/opentelemetry/api-key")!.inputs.stringData)).toContain("\"t\"");
        expect(find("downstream/apps/opentelemetry/instrumentation")!.inputs.spec.exporter.endpoint).toBe("http://opentelemetry-collector.observability.svc.cluster.local:4317");
        expect(find("downstream/apps/opentelemetry/opensearch-credentials")).toBeUndefined();
    });

    it("scrapes the GPUs, vLLM and Qdrant where they are, with 0.160's topology exporter", () => {
        const { exporters, receivers, service } = find("downstream/gpu/opentelemetry/collector")!.inputs.spec.config;
        expect(exporters.topology).toMatchObject({ cluster_name: "${env:K8S_CLUSTER_NAME}" });
        expect(exporters.topology.instance_url).toBeUndefined();
        expect(Object.keys(receivers).sort()).toEqual(["otlp", "prometheus/gpu", "prometheus/qdrant", "prometheus/vllm"]);
        expect(receivers["prometheus/vllm"].config.scrape_configs[0].relabel_configs[0].regex).toBe("suse-ai");
        expect(receivers["prometheus/qdrant"].config.scrape_configs[0].static_configs[0].targets).toEqual(["qdrant.suse-ai.svc.cluster.local:6333"]);
        expect(service.pipelines).toHaveProperty("metrics/gpu");
        // The overlays add their pipelines next to the base ones.
        expect(service.pipelines).toHaveProperty("traces/topology");
    });

    it("gives the scraped products the resource attributes SUSE AI 3.0's monitors select on", () => {
        const { processors, service } = find("downstream/gpu/opentelemetry/collector")!.inputs.spec.config;
        expect(processors["resource/vllm"].attributes).toEqual([
            { key: "service.namespace", value: "suse-ai", action: "insert" },
            { key: "suse.ai.product", value: "vllm", action: "insert" },
        ]);
        expect(processors["resource/qdrant"].attributes).toContainEqual({ key: "suse.ai.product", value: "qdrant", action: "insert" });
        expect(processors["resource/gpu"].attributes).toContainEqual({ key: "service.namespace", value: "gpu-operator", action: "insert" });
        expect(service.pipelines["metrics/vllm"].processors).toContain("resource/vllm");
        expect(service.pipelines["metrics/qdrant"].processors).toContain("resource/qdrant");
        expect(service.pipelines["metrics/gpu"].processors).toEqual(expect.arrayContaining(["transform/gpu-identity", "resource/gpu"]));
        // What the apps push gets a nonempty service.namespace before spans and metrics are derived.
        expect(service.pipelines.traces.processors).toContain("transform/suse-ai-namespace");
        expect(service.pipelines.metrics.processors).toContain("transform/suse-ai-namespace");
    });

    it("serves the model with vLLM from Application Collection, as the DGX Spark stack runs it, once the GPU Operator is ready", () => {
        const chart = find("downstream/gpu/vllm/chart")!.inputs;
        expect(chart.chart).toBe("oci://dp.apps.rancher.io/charts/vllm");
        const spec = chart.values.servingEngineSpec;
        expect(spec.runtimeClassName).toBe("nvidia");
        expect(spec.modelSpec).toEqual([expect.objectContaining({
            name: "model", modelURL: "Qwen/Qwen3-8B", registry: "dp.apps.rancher.io", repository: "containers/vllm-openai", tag: "0.19.0",
            requestCPU: 6, requestGPU: 1, shmSize: "64Gi", pvcStorage: "50Gi",
        })]);
        // The model's own context length unless set; the stack's engine settings.
        expect(spec.modelSpec[0].vllmConfig).toEqual({
            maxNumSeqs: 8, gpuMemoryUtilization: 0.7, tensorParallelSize: 1, enableChunkedPrefill: true, enablePrefixCaching: true,
            extraArgs: ["--trust-remote-code", "--kv-cache-dtype=fp8", "--max-num-batched-tokens=16384", "--async-scheduling", expect.stringMatching(/^--otlp-traces-endpoint=/)],
        });
        expect(spec.modelSpec[0]).not.toHaveProperty("hf_token");
        expect(spec.modelSpec[0]).not.toHaveProperty("storageClass");
        const waits = registered.filter(r => r.name.startsWith("downstream/gpu/vllm/vllm/wait-")).map(r => r.inputs);
        expect(waits).toContainEqual(expect.objectContaining({ path: "/apis/nvidia.com/v1/clusterpolicies/cluster-policy" }));
    });

    it("takes a model's own flags and image, as ~/stacks/vllm-node", () => {
        const [model] = find("downstream/spark/vllm/chart")!.inputs.values.servingEngineSpec.modelSpec;
        expect(model).toMatchObject({ registry: "docker.io", repository: "eugr/spark-vllm", tag: "latest", modelURL: "RadixArk/Qwen3.8-27B-NVFP4" });
        expect(model.vllmConfig.maxModelLen).toBe(262144);
        expect(model.vllmConfig.extraArgs).toEqual([
            "--trust-remote-code", "--kv-cache-dtype=fp8", "--max-num-batched-tokens=16384", "--async-scheduling", "--load-format=instanttensor",
            '--speculative-config={"method":"dflash","model":"z-lab/Qwen3.8-27B-DFlash2","num_speculative_tokens":8}',
            "--reasoning-parser=qwen3", "--tool-call-parser=qwen3_xml", "--enable-auto-tool-choice",
        ]);
    });

    it("keeps the model and compiled kernels in the node's directory, and gives the first start time", () => {
        const spec = find("downstream/spark/vllm/chart")!.inputs.values.servingEngineSpec;
        expect(spec.startupProbe.failureThreshold).toBe(180);
        expect(spec.modelSpec[0].extraVolumes).toEqual([{ name: "host-cache", hostPath: { path: "/var/lib/vllm-cache", type: "DirectoryOrCreate" } }]);
        expect(spec.modelSpec[0].extraVolumeMounts.map((m: { mountPath: string }) => m.mountPath)).toEqual(["/tmp/hub", "/root/.cache/vllm", "/root/.cache/flashinfer", "/root/.triton", "/root/.tilelang"]);
        expect(spec.containerSecurityContext).toEqual({ privileged: true });
        expect(spec.modelSpec[0].initContainer).toEqual({ name: "drop-caches", image: "docker.io/eugr/spark-vllm:latest", command: ["sh", "-c", "sync && echo 3 > /proc/sys/vm/drop_caches"] });
        expect(find("downstream/gpu/vllm/chart")!.inputs.values.servingEngineSpec).not.toHaveProperty("containerSecurityContext");
        const gpu = find("downstream/gpu/vllm/chart")!.inputs.values.servingEngineSpec.modelSpec[0];
        expect(gpu).not.toHaveProperty("initContainer");
        expect(gpu).not.toHaveProperty("extraVolumes");
        expect(gpu).not.toHaveProperty("extraVolumeMounts");
    });

    it("puts vLLM's router on a node port for other clusters, when asked", () => {
        expect(find("downstream/spark/vllm/node-port")!.inputs.spec).toMatchObject({ type: "NodePort", ports: [{ port: 80, targetPort: 8000, nodePort: 30080 }] });
        expect(find("downstream/gpu/vllm/node-port")).toBeUndefined();
    });

    it("leaves SUSE's topology exporter out for the upstream collector (arm64)", () => {
        const spec = find("downstream/chat/opentelemetry/collector")!.inputs.spec;
        expect(spec.image).toBe("docker.io/otel/opentelemetry-collector-contrib:0.149.0");
        expect(spec.config.exporters).not.toHaveProperty("topology");
        expect(spec.config.service.pipelines).not.toHaveProperty("traces/topology");
        expect(spec.config.connectors["routing/traces"].table[0].pipelines).toEqual(["traces/sampling", "traces/spanmetrics", "traces/model-relations", "traces/provider-relations", "traces/gateway"]);
        // With it (the default): its pipeline and its route.
        const apps = find("downstream/apps/opentelemetry/collector")!.inputs.spec.config;
        expect(apps.connectors["routing/traces"].table[0].pipelines).toEqual(["traces/sampling", "traces/spanmetrics", "traces/model-relations", "traces/provider-relations", "traces/topology"]);
    });

    it("sends the CLIENT and SERVER spans to a gateway, whose service graph becomes SUSE AI's service calls", () => {
        const chat = find("downstream/chat/opentelemetry/collector")!.inputs.spec.config;
        expect(chat.exporters["otlp/gateway"].endpoint).toBe("otlp-gateway.obs.lab.example.com:443");
        expect(chat.connectors["routing/traces"].table[0].pipelines).toEqual(["traces/sampling", "traces/spanmetrics", "traces/model-relations", "traces/provider-relations", "traces/gateway"]);
        expect(chat.service.pipelines["traces/gateway"]).toEqual({ receivers: ["routing/traces"], processors: ["filter/gateway-spans", "batch"], exporters: ["otlp/gateway"] });
        expect(chat.receivers).not.toHaveProperty("otlp/gateway");
        const obs = find("downstream/obs/opentelemetry/collector")!.inputs.spec.config;
        expect(obs.receivers["otlp/gateway"].protocols.grpc.endpoint).toBe("0.0.0.0:4319");
        expect(obs.connectors).toHaveProperty("servicegraph/suse_ai");
        expect(obs.service.pipelines["traces/servicegraph"].exporters).toEqual(["servicegraph/suse_ai"]);
        expect(obs.service.pipelines["metrics/servicegraph"].processors).toContain("transform/suse-ai-calls");
        expect(obs.exporters).not.toHaveProperty("otlp/gateway");
        expect(find("downstream/obs/opentelemetry/gateway-ingress")!.inputs.spec.rules[0].host).toBe("otlp-gateway.obs.lab.example.com");
        expect(find("downstream/chat/opentelemetry/gateway-ingress")).toBeUndefined();
        expect(find("downstream/obs/opentelemetry/service")!.inputs.spec.ports.map((p: { port: number }) => p.port)).toEqual([4317, 4318, 4319]);
        // vLLM's request spans to the collector, as the service the monitors select.
        const model = find("downstream/gpu/vllm/chart")!.inputs.values.servingEngineSpec.modelSpec[0];
        expect(model.vllmConfig.extraArgs).toContain("--otlp-traces-endpoint=http://opentelemetry-collector.observability.svc.cluster.local:4317");
        expect(model.env).toContainEqual({ name: "OTEL_SERVICE_NAME", value: "vllm" });
        expect(find("downstream/spark/vllm/chart")!.inputs.values.servingEngineSpec.modelSpec[0]).not.toHaveProperty("env");
    });

    it("installs the StackPacks the observer lists, once, with its bootstrap token", () => {
        const packs = registered.filter(r => r.name.startsWith("downstream/obs/stackpack/"));
        expect(packs.map(r => r.name).sort()).toEqual(["downstream/obs/stackpack/open-telemetry", "downstream/obs/stackpack/suse-ai"]);
        const suseAi = packs.find(r => r.name.endsWith("/suse-ai"))!.inputs;
        // Built from source: the .sts `lab stackpacks` built, uploaded by `up`.
        expect(suseAi).toMatchObject({
            url: "https://observability.obs.lab.example.com", name: "suse-ai", version: "3.0.0", unlocked: "overwrite",
            file: expect.stringMatching(/\/lab\/\.cache\/stackpacks\/suse-ai-3\.0\.0\.sts$/),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(suseAi).not.toHaveProperty("archive");
        const otel = packs.find(r => r.name.endsWith("/open-telemetry"))!.inputs;
        expect(otel).toMatchObject({ name: "open-telemetry", unlocked: "fail" });
        expect(otel).not.toHaveProperty("file");
    });

    it("runs Open WebUI with that API behind SUSE AI's filter, its traces to the cluster's collector", () => {
        const values = find("downstream/chat/open-webui/chart")!.inputs.values;
        const env = Object.fromEntries(values.extraEnvVars.map((e: { name: string; value: string }) => [e.name, e.value]));
        expect(env).toMatchObject({
            DEFAULT_MODELS: "Qwen/Qwen3-8B",
            ENABLE_OTEL: "true",
            ENABLE_OTEL_TRACES: "true",
            OTEL_SERVICE_NAME: "Open WebUI",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://opentelemetry-collector.observability.svc.cluster.local:4317",
        });
        expect(values).toMatchObject({ openaiBaseApiUrl: "http://spark.lab.example.com:30080/v1", openaiApiKeys: ["0p3n-w3bu!", "dummy"] });
        expect(env).not.toHaveProperty("OPENAI_API_BASE_URLS");
        expect(values.ingress).toMatchObject({ host: "open-webui.chat.lab.example.com", existingSecret: "wildcard-tls" });
        expect(values.pipelines.enabled).toBe(true);
        const pipelines = Object.fromEntries(values.pipelines.extraEnvVars.map((e: { name: string; value: string }) => [e.name, e.value]));
        expect(pipelines.OTEL_EXPORTER_HTTP_OTLP_ENDPOINT).toBe("http://opentelemetry-collector.observability.svc.cluster.local:4318");
        expect(pipelines.PIPELINES_URLS).toContain("/refs/tags/v2.0.0/integrations/oi-filter/suse_ai_filter.py");
    });
});
