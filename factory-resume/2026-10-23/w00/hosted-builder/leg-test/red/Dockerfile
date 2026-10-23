ARG BUN_IMAGE=docker.io/oven/bun:1.4.2@sha256:<IMAGE-ID>
FROM ${BUN_IMAGE}
# The hosted supervisor's podman-remote client, pinned by sha256 (scripts/check-factory-deployment-locks.ts refuses a download without one).
ADD --checksum=sha256:01b5ac597de2f7d55a7d52ba82c8e59df9e90355c5331849d6b7dbecf2345e7e https://github.com/containers/podman/releases/download/v5.8.7/podman-remote-static-linux_amd64.tar.gz /tmp/podman-remote.tar.gz
RUN tar -xzf /tmp/podman-remote.tar.gz -C /tmp bin/podman-remote-static-linux_amd64 \
  && install -m 0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/local/bin/podman \
  && rm -rf /tmp/podman-remote.tar.gz /tmp/bin
