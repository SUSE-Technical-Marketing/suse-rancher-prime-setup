FROM registry.suse.com/bci/nodejs:22

ARG USERNAME=pulumi
RUN zypper --non-interactive install -y git openssh make awk curl
RUN useradd -ms /bin/bash ${USERNAME}

# Set the user to the one created above, so that the apps install as that user
USER ${USERNAME}
WORKDIR /home/pulumi

# Use pnpm for node/typescript package management
RUN curl -fsSL https://get.pnpm.io/install.sh | sh -

# Install Pulumi
RUN VERSION=3.205.0 && \
    curl -sSL https://get.pulumi.com/ | bash -s -- --version $VERSION

# Install crd2pulumi
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
        x86_64) ARCH="amd64" ;; \
        aarch64) ARCH="arm64" ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    curl -sSL https://github.com/pulumi/crd2pulumi/releases/download/v1.5.4/crd2pulumi-v1.5.4-linux-$ARCH.tar.gz | tar -xz -f - crd2pulumi && \
    mv crd2pulumi $HOME/bin && \
    chmod +x $HOME/bin/crd2pulumi

# Install task
RUN sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d

RUN echo "export PATH=$HOME/bin:\$PATH" >> $HOME/.bashrc
