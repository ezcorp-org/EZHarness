# Supported test-account recovery packet

Preparation only. Do not execute without approval to change this account's password.
User: `8541e03e-192f-41d1-bda9-9fdfcd75355c`; retained normal auth receipt identifies an admin.
Installed source: `3fe533583bb71e4db339da80476cf39d27064086`.
Manifest: `0d3e5d06298bb11f4a223377070ced8fd0f905f19008575ec409b1cbb9132944`.
Private output directory: `/root/ezh-qualification-stage/oct05-final-qualification/password-reset` (exclusive, root0700).

Runnable implementation uses `/root/ezh-qualification-stage/oct05-final-qualification/password-reset` as the exclusive private output directory. It reuses the reviewed shared mint/stop/database-close/revoke helper. Exact commands, only after explicit password-change approval:

```text
sudo -n python3 /root/ezh-qualification-stage/oct05-final-qualification/password_reset.py mint --execute
sudo -n python3 /root/ezh-qualification-stage/oct05-final-qualification/password_reset.py reset --execute
```

`password_reset.py` SHA256: `07dd705cdafe5f16a76208d51b60f2cacc45470a958e4f6fef52f38aede604fe`.
Shared `stage_access_reset.py` SHA256: `e55d70e55ade4155bc1fcecf1f3dde043b142ff0fb4105bf1151aa42424368d1`. This separate copy preserves the original staging helper and receipts. Its revoke receipt records the password/session change accurately.
Five disposable reset tests passed: exact reset/audit/redeem/login/revoke sequence with truthful receipt, ambiguous audit refusal before redemption, shared-helper tamper refusal before import, occupied-session refusal before any HTTP effect, and health503 refusal before reset generation. Four shared staging tests passed. These are mocked endpoint tests; no password was changed by testing. The normal supplied-credential logins returned401; no session was created.

1. Recheck loaded qualification units and the current app child's stable PID/start ticks/all four UID62040 fields. Capture its environment privately in memory; require `EZCORP_DB_PATH=/var/lib/ezharness-qual-data/pglite`, no `DATABASE_URL`. Never output environment values.
2. Stop only supervisor, runner, then dedicated `user@62041.service`. Require inactive/MainPID0, no process with any credential62040/62041, and no live DB handles. Require fixed DB device66306/inode65145597/owner62040:62040/mode0700. Take a stopped backup; do not restore it after a possible key/reset commit.
3. Write a durable exclusive mint-attempt marker. Execute the existing CLI as UID/GID62040, cwd `/opt/ezharness`, using the captured environment and pinned Bun. Use the existing process-group/death-fence pattern and a60s bound; capture stdout/stderr root0600 before checking its result. On every outcome, prove the child and descendants terminated and no DB handles remain before any service restart. An uncertain mint keeps services stopped and evidence intact; never repeat the mint or restore a backup.

   Official CLI arguments: `key mint --user 8541e03e-192f-41d1-bda9-9fdfcd75355c --name oct05-final-qualification-stage --role admin --scopes admin,extensions`.

   Invoke the same exported `cli` from `/opt/ezharness/src/cli.ts` and use `/opt/ezharness/src/db/connection.ts` `closeDb()` in `finally`. This keeps the supported CLI behavior and closes its database owner. No direct settings/session insert.

4. Parse only the exact CLI `keyId` and one `ezk_` key from private output; write them to separate root0600 files. Keep the raw stdout private. Start the existing runner and supervisor once, then prove root-local health200 under the retained ingress hold.
5. Using that temporary bearer, call normal `POST /api/auth/reset-password` with `{ "userId": "8541e03e-192f-41d1-bda9-9fdfcd75355c" }`. Save a before-attempt marker and private response; do not repeat an uncertain generation.
6. Read `GET /api/audit-log?action=auth:password_reset_generated&limit=20`. Require one new entry after this attempt's timestamp, same actor/target user, and exact `/reset-password/[64 lowercase hex]` URL. No concurrent administrator reset activity is allowed; multiple matching new entries refuse redemption. Save it root0600; no URL/token output.
7. Generate one strong random password into a root0600 login-input file using the retained user's email privately. Redeem the exact token through normal `POST /api/auth/reset-password/:token`, JSON `{ "password": "<private value>" }`. Save an exclusive attempt and private response. No direct password/session database write.
8. Normal `POST /api/auth/login`, then `GET /api/auth/me` using a private CookieJar. Require the same admin user ID. No cookie/token/password output.
9. Revoke the temporary key with normal `DELETE /api/settings/developer/api-keys`, JSON `{ "keyId": "<observed CLI keyId>" }`, using that owner-bound bearer. Verify the old bearer cannot authenticate. Retain only private audit evidence.
10. Continue the reviewed workspace/build staging. Exact provider release approval remains a separate human decision. At the end, revoke this test session and verify old-cookie401.

Source pins read from installed files:

| File | SHA256 |
|---|---|
| index.ts | ae0280b1c363f711120eb8f9683a20de66486e0caef9372e081b792ca87fa205 |
| src/cli.ts | a08a0cb849b28524caa8af5459bd687929887ca61dabd00aa5c0f9453edfdd01 |
| src/auth/mint-api-key.ts | 2ebfca545a03e3b524d680940bf79b1ac9f7389270a6629f4d7f6750301cce0b |
| src/db/connection.ts | 2c530efae84b05b40a6a9f5f15819e3582cbbed3b9c58bf03ff058ab04417e0c |

Effect: changes only this existing isolated test admin's password; creates one temporary owner-bound API key and one normal session. The key has no automatic expiry; explicit revocation is required. Existing password becomes unusable. The normal reset handler changes only passwordHash and consumes its reset token; it does not revoke this user's other existing sessions or API keys. This packet revokes only the key and session it creates. A failure can leave a temporary key or reset token; retain its exact ID and revoke through the supported route when access is available. No provider activation or Incus effects in this packet.
