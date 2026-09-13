# Local AMD GPU tests

Run `bash scripts/verify-factory-local-gpu.sh`. The script runs ten seeded
matrix calculations in ten fresh rootless Podman containers. A final container
has no devices and must fail with `GPU_REQUIRED`. A user-scoped lock prevents
two copies of this test from using the GPU at once.

The image is pinned by digest. The measured host has an AMD Radeon RX 7900 XTX
with 25,753,026,560 usable VRAM bytes, Linux 7.0.3, PyTorch 2.12.0 and
ROCm HIP 7.14.60850. The probe uses a non-root user, a read-only filesystem,
no network, no capabilities, private IPC, and fixed CPU, memory and PID limits.

This ROCm runtime fails initialization when only `renderD128` is mapped. Its
memory-policy setup also touches the integrated GPU on `renderD129`. The local
probe maps both render devices and selects the RX 7900 XTX with
`ROCR_VISIBLE_DEVICES=0`. This is for trusted local fixtures. The environment
variable does not restrict a hostile process. The strict single-device and
tenant-dedicated host isolation gates remain open. This probe does not establish
GPU reimage, tenant reassignment, package isolation, or ten installed tenants.

No credentials are needed for this probe. The local S3 credential references
are described in [the storage guide](factory-local-storage.md).
