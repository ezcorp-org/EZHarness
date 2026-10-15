"""Trusted local hardware probe. This is not a package isolation test."""

import json
import os
import sys

import torch

assert torch.cuda.is_available(), "GPU_REQUIRED"
assert torch.cuda.device_count() == 1, "EXPECTED_ONE_VISIBLE_GPU"
assert os.getuid() != 0, "NON_ROOT_REQUIRED"
tenant = int(sys.argv[1])
assert 1 <= tenant <= 10, "TENANT_FIXTURE_OUT_OF_RANGE"
properties = torch.cuda.get_device_properties(0)
assert properties.name == "AMD Radeon RX 7900 XTX", "WRONG_ASSIGNED_GPU"
generator = torch.Generator(device="cuda").manual_seed(1000 + tenant)
matrix = torch.rand((256, 256), device="cuda", generator=generator)
product = matrix @ torch.eye(256, device="cuda")
torch.cuda.synchronize()
assert torch.allclose(product, matrix, atol=1e-6), "GPU_RESULT_MISMATCH"
print(json.dumps({"tenant_fixture": tenant, "device": properties.name,
                  "vram_bytes": properties.total_memory, "torch": torch.__version__,
                  "hip": torch.version.hip, "passed": True}))
