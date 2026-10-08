"""Read protected deployment identities. No caller supplies authority bytes."""
import hashlib
import importlib.util
import json
import os
import stat
import sys
import time
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class AuthorityIntegrityError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AuthorityIntegrityError("Incus admission authority: " + message)


def check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("protected admission readiness timed out")


def protected_path(path, owner=0):
    path = Path(path)
    require(path.is_absolute(), "absolute path required")
    resolved = path.resolve(strict=True)
    for item in dict.fromkeys((path, *path.parents, resolved, *resolved.parents)):
        status = item.stat()
        require(status.st_uid in (0, owner) and (not status.st_mode & 0o022
                or (str(item) == "/nix/store" and status.st_uid == 0
                    and stat.S_ISDIR(status.st_mode) and status.st_mode & 0o1777 == 0o1775)),
                "protected owner or mode changed")
    return resolved


def file_digest(paths, owner=0, supervisor_config_path=None):
    require(isinstance(paths, list) and 1 <= len(paths) <= 32
            and len(set(paths)) == len(paths), "bounded exact file list required")
    facts = []
    for name in sorted(paths):
        path = protected_path(name, owner)
        require(path.is_file(), "regular authority file required")
        with path.open("rb") as source:
            before = os.fstat(source.fileno())
            require(before.st_size <= 8 * 1024 * 1024, "authority file too large")
            payload = source.read(8 * 1024 * 1024 + 1)
            require(len(payload) <= 8 * 1024 * 1024, "authority file grew too large")
            if name == supervisor_config_path:
                config = json.loads(payload)
                for key in ("terminalClaimHandoffPath", "terminalClaimHandoffSha256", "terminalClaimHandoffRunId"):
                    config.pop(key, None)
                payload = canonical(config)
            digest = hashlib.sha256(payload).hexdigest()
            after = os.fstat(source.fileno())
        require(signature(before) == signature(after), "authority file changed during read")
        facts.append([name, str(path), digest])
    return hashlib.sha256(canonical(facts)).hexdigest()


def signature(status):
    return [status.st_dev, status.st_ino, status.st_mode, status.st_uid,
            status.st_gid, status.st_size, status.st_mtime_ns, status.st_ctime_ns]


class AdmissionAuthority:
    validation_error = AuthorityIntegrityError
    def __init__(self, config, app_command, owner=0, supervisor_config_path=None,
                 *, app_uid=None, app_gid=None):
        required = {"bundleRoot", "serviceFiles", "policyFiles"}
        require(isinstance(config, dict) and required <= set(config)
                and not set(config) - required - {"runtimeSource"}, "configuration incomplete")
        self.owner = owner
        self.root = protected_path(config["bundleRoot"], owner)
        self.config = config
        self.runtime_source = config.get("runtimeSource")
        require("runtimeSource" not in config or isinstance(self.runtime_source, str),
                "explicit runtime source required")
        self.app_uid, self.app_gid = app_uid, app_gid
        self.supervisor_config_path = supervisor_config_path
        if supervisor_config_path is not None:
            require(supervisor_config_path in config["serviceFiles"], "supervisor configuration missing from service closure")
        require(app_command == [str(self.root / "bin/bun"),
                                str(self.root / "web/build/index.js")],
                "managed app command differs from verified bundle")
        verifier_path = protected_path(self.root / "scripts/incus/stage-release-bundle.py", owner)
        spec = importlib.util.spec_from_file_location("incus_release_bundle", verifier_path)
        self.verifier = importlib.util.module_from_spec(spec)
        sys.dont_write_bytecode = True
        spec.loader.exec_module(self.verifier)
        self.verifier.verify(self.root, runtime_source=self.runtime_source,
                             app_uid=app_uid, app_gid=app_gid, owner=owner)
        self.launch_runtime_identity = self.runtime_identity()
        self.launch_files = self.snapshot()
        self.security_digest = hashlib.sha256((self.root / self.verifier.MANIFEST).read_bytes()).hexdigest()
        self.launch_service_digest = file_digest(config["serviceFiles"], owner, supervisor_config_path)

    def snapshot(self, deadline=None):
        facts = {}
        for count, (path, status) in enumerate(self.verifier.immutable_entries(self.root), start=1):
            check_deadline(deadline)
            require(count <= 120000, "bundle closure too large")
            relative = str(path.relative_to(self.root))
            require(relative not in facts, "bundle enumeration repeated a path")
            require(status.st_uid == self.owner, "bundle owner changed")
            if not stat.S_ISLNK(status.st_mode):
                require(not status.st_mode & 0o022, "bundle became writable")
            facts[relative] = signature(status)
        return facts

    def runtime_identity(self):
        if self.runtime_source is None:
            return None
        try:
            return self.verifier.check_bound_runtime(self.root, self.runtime_source,
                                                    self.app_uid, self.app_gid, self.owner)
        except ValueError as error:
            raise AuthorityIntegrityError(str(error)) from None

    def observe(self, deadline=None):
        check_deadline(deadline)
        require(self.runtime_identity() == self.launch_runtime_identity,
                "runtime binding changed; restart required")
        require(self.snapshot(deadline) == self.launch_files, "loaded app closure changed; restart required")
        service = file_digest(self.config["serviceFiles"], self.owner, self.supervisor_config_path)
        require(service == self.launch_service_digest, "loaded service changed; restart required")
        policy = file_digest(self.config["policyFiles"], self.owner)
        check_deadline(deadline)
        return {"securitySourceDigest": self.security_digest,
                "supervisorServiceDigest": service,
                "hostPolicyDigest": policy}
