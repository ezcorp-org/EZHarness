# Candidate image build and transfer — 9ca27583

This receipt records the archived-source production image build only. It does not prove any runtime, browser, upgrade, resource, or hosted CI gate.

The controller required the checked-out commit and the Docker OCI revision to equal `9ca275838faf30666da5dba1c0eba141dd053050`. It built from `git archive` of that commit through the committed `scripts/lib/build-archived-image.sh` helper, with `--load` into default Docker. It then saved that Docker image and loaded it into native rootless Podman. The outer command exited `0`.

`independent-image-comparison.txt` is a second post-build inspection: Docker and native Podman have the same image ID and both report the same full OCI revision label. The two `*.safe.json` files retain only image identity, labels, platform, size, tags, entrypoint, command, user, and working directory. They intentionally omit raw inspect environment and storage fields.

`archived-build.log.txt` is the complete build output with terminal colour controls removed. `original-receipt-inputs.sha256` retains hashes for the unmodified private receipt inputs. The log scan found only compiled asset filenames containing security-related words, not credential values.

The controller copies record the exact build controller used and the committed archived-image helper. `SHA256SUMS` hashes this durable directory and excludes itself.

`healthcheck-attribution/` verifies that the raw native image config retains the Docker healthcheck even though Podman image inspection omits it. This local lifecycle compose starts its app without an active container healthcheck and uses explicit HTTP readiness. Production compose declares an explicit healthcheck. No rootless Podman production-compose run is claimed. The parent independently checked the raw config hash, byte count, and exact healthcheck fields.
