#!/usr/bin/env bash
# Validate the exact SvelteKit output transferred from the one mapped browser
# build. Consumer jobs only check files; the build job also restores that
# payload into a clean checkout and starts Vite preview from it.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:---check}"
web_root="${EZCORP_BROWSER_BUILD_ROOT:-$repo_root/web}"

require_build_output() {
	local web_root=$1
	[[ -f "$web_root/build/client/manifest.json" ]] || {
		echo "browser build artifact is missing build/client/manifest.json" >&2
		return 1
	}
	[[ -f "$web_root/.svelte-kit/output/client/manifest.json" ]] || {
		echo "browser build artifact is missing .svelte-kit/output/client/manifest.json" >&2
		return 1
	}
	find "$web_root/.svelte-kit/output/server" -type f -print -quit 2>/dev/null | grep --line-buffered -q . || {
		echo "browser build artifact is missing .svelte-kit/output/server" >&2
		return 1
	}
}

case "$mode" in
	--check)
		require_build_output "$web_root"
		echo "browser build artifact contains client maps and SvelteKit preview server"
		;;
	--round-trip-preview)
		require_build_output "$web_root"
		tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/ezh-browser-build-transfer.XXXXXX")"
		server_pid=""
		cleanup() {
			if [[ -n "$server_pid" ]]; then
				# `setsid` above isolates the shell and Vite/Bun children, so this
				# stops the whole preview tree before its temporary build is removed.
				kill -- "-$server_pid" 2>/dev/null || true
				wait "$server_pid" 2>/dev/null || true
			fi
			rm -rf "$tmp_root"
		}
		trap cleanup EXIT

		# This archive has the same root and paths as upload-artifact's two
		# `web/...` inputs downloaded with `path: web` in each consumer job.
		artifact="$tmp_root/browser-coverage-build.tar"
		tar -C "$repo_root/web" -cf "$artifact" build .svelte-kit/output
		mkdir -p "$tmp_root/consumer/web"
		# A consumer has checked-out source and installed dependencies, but none
		# of the producer's generated output until the artifact is restored. Use
		# tracked web files only: test results and local coverage receipts must
		# never influence this checkout-shaped regression.
		git -C "$repo_root" ls-files -z -- web | \
			tar -C "$repo_root" --null --files-from=- -cf - | tar -C "$tmp_root/consumer" -xf -
		# The built server imports root runtime dependencies (for example
		# drizzle-orm). CI's setup action installs both workspace roots.
		ln -s "$repo_root/node_modules" "$tmp_root/consumer/node_modules"
		ln -s "$repo_root/web/node_modules" "$tmp_root/consumer/web/node_modules"
		tar -C "$tmp_root/consumer/web" -xf "$artifact"
		require_build_output "$tmp_root/consumer/web"

		port="$(node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
		entry_file="$(find "$tmp_root/consumer/web/build/client/_app/immutable/entry" -type f -name 'start*.js' -print -quit)"
		[[ -n "$entry_file" ]] || { echo "browser build artifact has no client start entry" >&2; exit 1; }
		entry_url="/_app/immutable/entry/$(basename "$entry_file")"
		setsid bash -c '
			cd "$1"
			exec env EZCORP_PREVIEW_APP_HOST=localhost PI_SKIP_INIT=1 bun run preview -- --port "$2" --strictPort
		' bash "$tmp_root/consumer/web" "$port" >"$tmp_root/preview.log" 2>&1 &
		server_pid=$!
		for _ in $(seq 1 40); do
			# A 200 immutable client entry proves Vite has initialized the restored
			# SvelteKit server and can serve the transferred build. The DB-free mock
			# preview deliberately renders its login error page with 500, so inspect
			# that real route's HTML rather than treating its expected status as ready.
			if curl --fail --silent "http://127.0.0.1:$port$entry_url" >"$tmp_root/entry.js" 2>/dev/null &&
				curl --silent "http://127.0.0.1:$port/login" >"$tmp_root/preview.html" 2>/dev/null; then
				grep -q '<!doctype html' "$tmp_root/preview.html" &&
					grep -q 'data-hydrated' "$tmp_root/preview.html" || {
						echo "restored browser build preview did not render the SvelteKit login document" >&2
						exit 1
					}
				echo "restored browser build preview served $entry_url and /login on port $port"
				exit 0
			fi
			sleep 0.25
		done
		cat "$tmp_root/preview.log" >&2
		echo "restored browser build preview did not become ready" >&2
		exit 1
		;;
	*)
		echo "usage: $0 [--check|--round-trip-preview]" >&2
		exit 2
		;;
esac
