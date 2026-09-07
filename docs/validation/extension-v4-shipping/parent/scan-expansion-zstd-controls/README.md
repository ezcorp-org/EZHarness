# Recursive archive checks including Zstandard

The earlier scan expanded gzip, tar, and ZIP, but omitted five published `.tar.zst` evidence bundles. The updated helper decompresses Zstandard into the same recursive queue and scans the resulting tar members. No Gitleaks rule or exception changed. The final staged scan must pass separately.

Nine controls pass: nested ZIP/tar/gzip retains distinct duplicate entries and exact payload hashes; nested Zstandard/tar/gzip retains exact hashes; corrupt gzip, ZIP, and Zstandard are rejected; tar and Zstandard-contained traversal are rejected; tar and ZIP archives with 20,001 directory headers are rejected. The actual outer control exit is zero; expected negative cases retain nonzero exits. Input archives exist only in temporary control directories.

The helper caps expanded payload bytes at 512 MiB and archive headers and payload members at 20,000 each. It streams tar headers. Python parses the ZIP central directory before its entry count can be rejected; no streaming ZIP-header claim is made. The final scan records exact helper bytes and checks the complete staged snapshot.
