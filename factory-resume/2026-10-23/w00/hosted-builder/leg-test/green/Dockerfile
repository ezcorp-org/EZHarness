ARG BUN_IMAGE=docker.io/oven/bun:1.4.2@sha256:<IMAGE-ID>
FROM ${BUN_IMAGE}
# The hosted supervisor's podman-remote client, pinned by sha256: the RUN right after the ADD checks the sum before anything reads the file
# (scripts/check-factory-deployment-locks.ts). Not ADD --checksum: the hosted builder (Podman 4.9.3, Buildah 1.33) refuses that flag.
ADD https://github.com/containers/podman/releases/download/v5.8.7/podman-remote-static-linux_amd64.tar.gz /tmp/podman-remote.tar.gz
RUN echo "01b5ac597de2f7d55a7d52ba82c8e59df9e90355c5331849d6b7dbecf2345e7e  /tmp/podman-remote.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/podman-remote.tar.gz -C /tmp bin/podman-remote-static-linux_amd64 \
  && install -m 0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/local/bin/podman \
  && rm -rf /tmp/podman-remote.tar.gz /tmp/bin
RUN /usr/local/bin/podman --version
