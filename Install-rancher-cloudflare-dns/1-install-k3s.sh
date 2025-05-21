#!/bin/bash
set -e

# Install K3s 
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.31.6+k3s1" sh -

# Copy kubeconfig and make it readable

mkdir ~./kube
cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
chmod 600 ~/.kube/config

kubectl get nodes
