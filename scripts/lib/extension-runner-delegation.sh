configure_extension_runner_delegation() {
  local runner_user runner_uid manager controllers controller
  runner_user="$(id -un)"
  runner_uid="$(id -u)"
  manager="user@$runner_uid.service"
  if awk -F: -v manager="$manager" '$3 ~ ("/" manager "(/|$)") { found = 1 } END { exit !found }' /proc/self/cgroup; then
    echo "Run CI provisioning outside $manager; restarting it would terminate this job." >&2
    return 1
  fi
  sudo install -d -m 0755 "/run/systemd/system/$manager.d"
  printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee "/run/systemd/system/$manager.d/90-extension-runner.conf" >/dev/null
  sudo systemctl daemon-reload
  sudo loginctl enable-linger "$runner_user"
  sudo systemctl restart "$manager"
  controllers="$(systemctl show "$manager" --property=DelegateControllers --value)"
  for controller in cpu memory pids; do
    if [[ " $controllers " != *" $controller "* ]]; then
      echo "The CI user manager did not delegate required controller: $controller" >&2
      return 1
    fi
  done
  export XDG_RUNTIME_DIR="/run/user/$runner_uid"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  systemctl --user show-environment >/dev/null
}
