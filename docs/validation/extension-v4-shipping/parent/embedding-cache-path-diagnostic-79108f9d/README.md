# Embedding cache path diagnostic

This is a safe checkpoint for a short, direct Transformers.js initialization
inside image `ezcorp:embedding-cache-final-79108f9deb12` at source
`79108f9deb128ffa9780a08530f0121273ddc5ef`. The command ran as UID/GID 1001,
exited 0, and removed its owned state directory.

The diagnostic uses the public `env.fetch` hook to retain model URL pathnames
and basenames only. It saw this exact six-item order: `config.json`,
`tokenizer_config.json`, `config.json`, `tokenizer.json`,
`tokenizer_config.json`, and `onnx/model.onnx`. The four persisted model files
are in the per-pipeline cache directory. One attempted
write to the package-relative default cache produces the retained private
EACCES identity.

This is direct library initialization in the image. Its default cache path is
under root `node_modules/.bun`; the HTTP server error path is under web
`node_modules`. Those entrypoints are not equated. Both use the same pinned
Transformers package and show the omitted-default-cache behavior. The
controller inputs are inert exact copies. Raw stderr, state, and network
records remain private.

The original input hash receipt uses private absolute paths and is retained as `inputs/original-input-hashes.sha256.txt`. The root `SHA256SUMS` verifies the published files with local paths.
