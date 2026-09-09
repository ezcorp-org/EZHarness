install_extension_runner_conmon() (
  set -euo pipefail
  case "$(uname -m)" in
    x86_64) architecture=amd64; checksum=1d97294c14c43d477e0a0826e9cd0f2a2af373ddfafe6f10252e8a3c43f32be6 ;;
    aarch64) architecture=arm64; checksum=c2fa62b3555eb0a729d853df23c5784d970f46050f2fb5f9931ded1bf455d216 ;;
    *) echo "Unsupported CI conmon architecture" >&2; exit 1 ;;
  esac
  temporary="$(mktemp -d)"
  trap 'rm -f "$temporary/conmon"; rmdir "$temporary"' EXIT
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 120 --retry 3 \
    "https://github.com/containers/conmon/releases/download/v2.2.1/conmon.$architecture" -o "$temporary/conmon"
  printf '%s  %s\n' "$checksum" "$temporary/conmon" | sha256sum --check
  sudo install -d -m 0755 /usr/local/libexec/ezcorp-extension-runner /etc/containers/containers.conf.d
  sudo install -o root -g root -m 0755 "$temporary/conmon" /usr/local/libexec/ezcorp-extension-runner/conmon-2.2.1
  printf '[engine]\nconmon_path=["/usr/local/libexec/ezcorp-extension-runner/conmon-2.2.1"]\n' \
    | sudo tee /etc/containers/containers.conf.d/90-extension-runner-conmon.conf >/dev/null
)
