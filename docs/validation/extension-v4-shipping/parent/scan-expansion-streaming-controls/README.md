# Streaming archive expansion controls

The parent repeats all 16 controls with actual outer exit 0. Nested formats, duplicate filenames, and earlier-member tar hardlinks preserve exact distinct output bytes and hashes. Corrupt archives, unsafe paths, missing or forward hardlink targets, symlinks, oversized payloads, and excessive directory headers are rejected. Hardlink byte limits are checked before copying.

The two historical coverage bundles expand to 2,486,906,880 intermediate tar bytes. Their regular member copies add 2,472,558,735 bytes; 3,100 copied hardlinks add 2,430,908,776 bytes. The resulting 7,390,374,391 bytes justify the fixed 8 GiB aggregate bound. The unchanged 20,000 header and payload-member limits still apply. Zstandard streams in 1 MiB chunks; tar headers stream. Python reads the ZIP central directory before its count check.

The earlier 512 MiB attempt failed at the byte limit; the next streaming attempt failed on a legitimate hardlink. Both stopped before Gitleaks and cleaned up successfully. They provide no secret-scan result. The final staged scan is separate.

Inert helper, configuration, and probe files retain executed input bytes. Workspace and random temporary-root paths in diagnostic text are replaced with named placeholders. Temporary control archives and extracted payloads are not published.
