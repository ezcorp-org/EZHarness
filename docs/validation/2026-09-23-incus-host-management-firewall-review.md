# Review: deny feature guests access to host management ports

This is a source proposal only. No NixOS source, running firewall, Incus setting, or guest was changed. The selected host is `sandbox-server`; read-only SSH on 2026-09-23 found `/home/dev/work/nixos` at commit `f7c716c6c808f5d4490aca230e1f4e52c228980f`. Its only local edits were in `tasks/`.

## Current path and rule order

The reviewed Incus bridge is `ezharness0` at `10.173.0.1/24`. The server recipe binds the Incus API to `100.81.181.39:8443`. A read-only route lookup for a guest source returned `local 100.81.181.39 from 10.173.0.2 dev lo ... iif ezharness0`, so that packet reaches host INPUT, not FORWARD. There are no current Incus instances or HTTPS listener, so direct guest connectivity was not tested.

The deployed `flake.nix` sets `my.incus.bridgeName = "ezharness0"`. `modules/incus.nix` opens TCP 53 and UDP 53/67 on that interface. The active `inet nixos-fw input` chain has priority `filter` and policy `drop`; `input-allow` has a **global** `tcp dport 22 accept` before the bridge DNS/DHCP accepts. It has no TCP 8443 accept. The Incus bridge INPUT chain also allows only DNS/DHCP. Thus the current rules allow guest-to-host SSH on TCP 22 and drop new guest-to-host Incus API traffic on TCP 8443. Tailscale operator SSH arrives on `tailscale0`, a different ingress interface.

The pinned NixOS `firewall-nftables.nix` module appends `networking.firewall.extraInputRules` at the **end** of `input-allow`, after the TCP 22 accept. It also accepts established traffic in `input` before reaching `input-allow`. A deny through `extraInputRules` would therefore fail to protect TCP 22 and could miss established flows. Incus's separate INPUT chain uses an accept policy, but an accept in one nftables base chain does not bypass a drop in another input chain. [Nftables chain ordering](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains) documents this behavior.

## Proposed one-file diff for review

Apply only after separate review of the source and a maintenance plan. This chain denies **host-destined** TCP 22 and 8443 from the feature bridge, regardless of which host IP a guest chooses. It does not affect forwarded guest egress, host replies, bridge DNS/DHCP, or operator SSH entering through `tailscale0`. Priority `filter - 10` runs before the NixOS `filter` chain's established and global SSH accepts.

```diff
diff --git a/flake.nix b/flake.nix
--- a/flake.nix
+++ b/flake.nix
@@
           my.docker.enable = true;
           my.incus.enable = true;
           my.incus.bridgeName = "ezharness0";
+          networking.nftables.tables."ezh-guest-management" = {
+            family = "inet";
+            content = ''
+              chain input {
+                type filter hook input priority filter - 10; policy accept;
+                iifname "ezharness0" tcp dport { 22, 8443 } drop
+              }
+            '';
+          };
           my.devContainer.enable = true;
```

NixOS's `networking.nftables.tables` renders this as a separate `inet` table. Its build checks the generated rules with `nft --check` in a sandbox. A read-only local `nix eval --offline --impure --raw --expr` with an injected module accepted the table's `family` and `content` options. A standalone unprivileged `nft -c` could not initialize netlink (`Operation not permitted`), so it is **not** syntax evidence.

After applying the diff to a review branch, run offline without activating the server:

```sh
cd /home/dev/work/nixos
nix build --offline --no-link .#nixosConfigurations.sandbox-server.config.system.build.toplevel
```

The build must exit zero, including the generated nftables ruleset check. Before any `nixos-rebuild test` or `switch`, compare the resulting rules with the reviewed diff and retain an operator SSH recovery path. After a separately approved activation, read back the new `inet ezh-guest-management input` chain and confirm its priority and drop rule, keep TCP 53 and UDP 53/67 on `ezharness0`, and verify SSH over `tailscale0`. A disposable feature guest must fail to connect to both the host's bridge and Tailscale addresses on TCP 22 and to the Incus API address on TCP 8443. Those live checks remain open.
