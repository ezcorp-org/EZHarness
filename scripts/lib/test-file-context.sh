#!/usr/bin/env bash
# Apply startup context to one test child. Other files inherit their caller's
# environment. exec preserves the PID used by the process-group watchdog.
_ez_test_file_context_exec() {
  if [ "$#" -lt 2 ]; then
    echo "usage: test-file-context.sh <test path> <command> [arguments...]" >&2
    return 2
  fi
  local test_file="${1#./}"
  shift
  if [ "$test_file" = "tests/postgres/factory-gateway-process.test.ts" ]; then
    if [ -z "${FACTORY_TEST_POSTGRES_URL:-}" ]; then
      echo "gateway process test requires FACTORY_TEST_POSTGRES_URL" >&2
      return 2
    fi
    local gateway_url
    gateway_url=$(bun -e '
      try {
        const admin = new URL(process.env.FACTORY_TEST_POSTGRES_URL);
        const target = new URL(process.env.DATABASE_URL || admin.toString());
        if (![admin, target].every(u => ["postgres:", "postgresql:"].includes(u.protocol) && u.hostname)) throw new Error();
        if (!process.env.DATABASE_URL) target.pathname = `/factory_gateway_${crypto.randomUUID().replaceAll("-", "")}`;
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(decodeURIComponent(target.pathname.slice(1)))) throw new Error();
        console.log(target.toString());
      } catch {
        console.error("gateway process test requires valid PostgreSQL URLs and a safe database name");
        process.exit(2);
      }
    ') || return 2
    export DATABASE_URL="$gateway_url"
  fi
  exec "$@"
}

ez_test_file_context() ( _ez_test_file_context_exec "$@" )

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _ez_test_file_context_exec "$@"
fi
