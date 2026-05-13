import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HarvesterDownstreamCluster } from "./src/downstream/harvester";

// Example usage of the HarvesterDownstreamCluster component using Kubernetes CRDs

// Configure access to the Rancher Kubernetes cluster
const rancherProvider = new k8s.Provider("rancher", {
    kubeconfig: pulumi.secret(`
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://rancher.example.com:6443
    certificate-authority-data: LS0t...
  name: rancher
contexts:
- context:
    cluster: rancher
    user: rancher-user
  name: rancher
current-context: rancher
users:
- name: rancher-user
  user:
    token: token-abcd1234:xyz789
`),
});

// Alternative: Use existing kubeconfig file
// const rancherProvider = new k8s.Provider("rancher", {
//     kubeconfig: fs.readFileSync("~/.kube/rancher-config", "utf8"),
// });

// Create a downstream Harvester cluster using Kubernetes Custom Resources
const downstreamCluster = new HarvesterDownstreamCluster("my-harvester-cluster", {
    rancherConfig: {
        provider: rancherProvider,
        namespace: "fleet-default", // Optional: defaults to "fleet-default"
    },
    clusterName: "my-harvester-downstream",
    displayName: "My Harvester Downstream Cluster",
    description: "A Kubernetes cluster running on Harvester infrastructure managed via CRDs",
    cloudCredentialSecretName: "harvester-cloud-credential", // Must exist in Rancher

    // Configure RKE2 settings
    rke2Config: {
        kubernetesVersion: "v1.28.13+rke2r1",
        cni: "calico",
        disableKubeProxy: false,
        etcdExposeMetrics: false,
        chartValues: {
            "rke2-calico": {
                "calico": {
                    "mode": "vxlan",
                }
            }
        },
    },

    // Define node pools
    nodePools: [
        {
            name: "control-plane",
            quantity: 3,
            cpuCount: 4,
            memorySize: "8Gi",
            diskSize: "80Gi",
            diskBus: "virtio",
            networkName: "default/mgmt-untagged",
            imageName: "default/ubuntu22-server-cloudimg-amd64",
            vmNamespace: "default",
            sshUser: "ubuntu",
            etcdRole: true,
            controlPlaneRole: true,
            workerRole: false,
            userData: `#cloud-config
package_update: true
packages:
  - curl
  - wget
  - vim
  - htop
ssh_authorized_keys:
  - ssh-rsa AAAAB3NzaC1yc2E... # Your SSH public key
runcmd:
  - echo "Control plane node ready" > /tmp/node-ready
  - systemctl enable --now iscsid
`,
        },
        {
            name: "worker",
            quantity: 2,
            cpuCount: 2,
            memorySize: "4Gi",
            diskSize: "40Gi",
            diskBus: "virtio",
            networkName: "default/mgmt-untagged",
            imageName: "default/ubuntu22-server-cloudimg-amd64",
            vmNamespace: "default",
            sshUser: "ubuntu",
            etcdRole: false,
            controlPlaneRole: false,
            workerRole: true,
            userData: `#cloud-config
package_update: true
packages:
  - curl
  - wget
  - htop
ssh_authorized_keys:
  - ssh-rsa AAAAB3NzaC1yc2E... # Your SSH public key
runcmd:
  - echo "Worker node ready" > /tmp/node-ready
`,
        },
    ],

    // Network configuration (optional)
    network: {
        cidr: "10.42.0.0/16",
        dnsServers: ["8.8.8.8", "8.8.4.4"],
        domain: "cluster.local",
    },

    // Labels and annotations
    labels: {
        "cluster.cattle.io/creator": "pulumi",
        "environment": "development",
        "infrastructure": "harvester",
    },
    annotations: {
        "description": "Created by Pulumi automation using Kubernetes CRDs",
        "contact": "admin@example.com",
    },

    // Environment variables for the cluster agent (optional)
    agentEnvVars: [
        { name: "HTTP_PROXY", value: "http://proxy.example.com:8080" },
        { name: "HTTPS_PROXY", value: "http://proxy.example.com:8080" },
        { name: "NO_PROXY", value: "localhost,127.0.0.1,10.0.0.0/8" },
    ],
});

// Export useful information about the cluster
export const clusterName = downstreamCluster.clusterName;
export const clusterStatus = downstreamCluster.status;
export const clusterReady = downstreamCluster.ready;
export const kubeconfigSecret = downstreamCluster.clientSecretName;
export const kubeconfigCommand = downstreamCluster.kubeconfig;

// Export references to the underlying Kubernetes resources
export const clusterResource = downstreamCluster.cluster;
export const machineConfigResources = downstreamCluster.machineConfigs;

// Example of how to access the kubeconfig once the cluster is ready
export const kubeconfigContent = pulumi.all([downstreamCluster.ready, downstreamCluster.clientSecretName])
    .apply(([ready, secretName]) => {
        if (ready && secretName) {
            // In a real scenario, you would use the Kubernetes provider to read the secret
            return `# Use this command to get the kubeconfig:
# kubectl get secret ${secretName} -n fleet-default -o jsonpath='{.data.value}' | base64 -d > cluster-kubeconfig.yaml`;
        }
        return "Cluster not ready yet";
    });