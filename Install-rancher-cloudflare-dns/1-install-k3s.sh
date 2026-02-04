#!/bin/bash
set -e

# Install K3s 
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.34.3+k3s3" sh -

# Wait for kubeconfig to become available
CONFIG_FILE="/etc/rancher/k3s/k3s.yaml"
echo "Waiting for kubeconfig file to be created..."
while [ ! -f "$CONFIG_FILE" ]; do
  sleep 2
done

# Copy kubeconfig and make it readable
mkdir -p ~/.kube
cp "$CONFIG_FILE" ~/.kube/config
chmod 600 ~/.kube/config

echo "K3s is installed. Verifying nodes..."
kubectl get nodes
