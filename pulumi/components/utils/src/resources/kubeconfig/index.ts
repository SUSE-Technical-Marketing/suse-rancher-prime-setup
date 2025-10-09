export * from "./rancher";
export * from "./remote";
export { KubeConfig };
import * as yaml from "js-yaml";

class KubeConfig {
    kubeconfig: string;

    constructor(kubeconfig: string) {
        this.kubeconfig = kubeconfig;
    }

    insecure(): KubeConfig {
        const kubeyaml = yaml.load(this.kubeconfig) as any;
        if (!kubeyaml.clusters || kubeyaml.clusters.length === 0) {
            throw new Error("Invalid kubeconfig: No clusters found.");
        }
        kubeyaml.clusters[0].cluster["insecure-skip-tls-verify"] = true;
        delete kubeyaml.clusters[0].cluster["certificate-authority-data"];
        const kubeconfig = yaml.dump(kubeyaml);
        return new KubeConfig(kubeconfig);
    }

    updateServerAddress(hostname: string, port: number = 6443): KubeConfig {
        const kubeyaml = yaml.load(this.kubeconfig) as any;
        if (!kubeyaml.clusters || kubeyaml.clusters.length === 0) {
            throw new Error("Invalid kubeconfig: No clusters found.");
        }
        kubeyaml.clusters[0].cluster.server = `https://${hostname}:${port}`;
        const kubeconfig = yaml.dump(kubeyaml);
        return new KubeConfig(kubeconfig);
    }

}


