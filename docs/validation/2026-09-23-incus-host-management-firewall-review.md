# Review: deny feature guests access to host management ports

This is a built host change awaiting separate approval. No NixOS source, running firewall, Incus setting, or guest was changed on `sandbox-server`. The patch is in isolated NixOS worktree `/home/dev/work/nixos/.worktrees/ezh-guest-management-firewall`, commit `7e442febfdbbb702c9ab1c96b7dbb1431f1070a4`; validation record commit `ebdf7342c27c01c4438b294057a8ad1856f93d37` changes only its documentation. Read-only SSH on 24 September confirmed the server source remains at base commit `f7c716c6c808f5d4490aca230e1f4e52c228980f` with two local `tasks/` edits. Its running generation is `/nix/store/spkx13gcwryacv7fd7sx3mrw1q351mg8-nixos-system-sandbox-server-26.05.20260430.15f4ee4`.

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

NixOS's `networking.nftables.tables` renders this as a separate `inet` table. Its build checks the generated rules with `nft --check` in a sandbox. A bounded online build of the exact isolated worktree exited 0; `networking.nftables.checkRuleset = true`, and the generated nft ruleset placed the new priority `filter - 10` drop before the current priority `filter` SSH accept. The full [NixOS validation record](/home/dev/work/nixos/.worktrees/ezh-guest-management-firewall/docs/incus-guest-management-firewall-validation.md) includes the command and derivations.

| Built item | Exact value |
| --- | --- |
| Toplevel derivation | `/nix/store/ipcjmwjb1pavrfmm2cyfxp5krqmkskgl-nixos-system-sandbox-server-26.05.20260430.15f4ee4.drv` |
| Toplevel output | `/nix/store/pcnpahs54gv9x9p5f164zspwg64sr4wp-nixos-system-sandbox-server-26.05.20260430.15f4ee4` |
| NAR hash | `sha256-rqo+pnGKmgo3x6J1VyQtxexTh9wxPgZKQihshfWiLj0=` |
| nft rules output | `/nix/store/035589hnpimbb7gbclm9vxg4jr2zlvns-nftables-rules` |

Before any `nixos-rebuild test` or `switch`, compare the resulting rules with the reviewed diff and retain an operator SSH recovery path. Activation is **not approved by this packet**. After a separately approved activation, read back the new `inet ezh-guest-management input` chain and confirm its priority and drop rule, keep TCP 53 and UDP 53/67 on `ezharness0`, and verify SSH over `tailscale0`. A disposable feature guest must fail to connect to both the host's bridge and Tailscale addresses on TCP 22 and to the Incus API address on TCP 8443. Those live checks remain open.
