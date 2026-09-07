# R4 failed duration and kernel diagnostics

The duration driver is committed `156fd9a46c3666e711e54f71350a53b6646e997f`; the kernel diagnostic driver is committed `473f955a`. Both use base candidate image `localhost/ezcorp-extension-v4:shipping-adbba8a6` (`sha256:3800bd95cd2e106d1d3b9fb304cddce94db5872006f5a4b782d673e01a601b8f`).

- Duration run: 35 accepted cycles, 350 accepted reconnects, 190,920 ms; command exit 1 and owned cleanup exit 0. Cycle 36 completed its work but failed acceptance on the unchanged 64 MiB memory budget. Warm-to-failure container measurement was +73,610,035 bytes (70.2 MiB).
- Kernel diagnostic: cycle 23 failed with command exit 1 and owned cleanup exit 0. The exact app PID was the only recorded cgroup member. Warm-to-failure cgroup current grew 96,022,528 bytes; app smaps anonymous/private grew 77,295,616 bytes (73.7 MiB, 77.3 MB decimal); app Pss_File remained 72,228,864 bytes. Cgroup file grew 18,677,760 bytes, which is distinct from the app Pss_File result.
- [Parent replay of stopped owned PGlite aggregate](parent-db-aggregate/README.md): `extension_release_records` had 116 rows and 96,452 payload-text bytes. Public relation data was about 3,440,640 bytes. These values do not identify the anonymous allocator or prove a leak.

Per-run `driver-source.ts.txt` files and hashes preserve each actual driver. Only safe exit, provenance, command, summary, and script-hash records are retained. Compose logs, runner logs, cookies, API keys, and retained database state are excluded.
