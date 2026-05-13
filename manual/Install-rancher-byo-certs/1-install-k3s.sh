#!/bin/bash
set -e

# Install K3s without Traefik
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.34.3+k3s3" sh -

# Make the kubeconfig readable for erin
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
