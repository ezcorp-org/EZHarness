# Factory pool process

The factory pool is an independent Bun process. It uses the existing PostgreSQL pool ledger and mTLS admission routes. It does not use the product database.

Start it with the pinned Bun binary and one private configuration file:

```sh
/tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun src/factory/pool/process.ts /run/ezharness/factory-pool/pool-process.json
```

The configuration file and every referenced file must use an absolute path. Each file must be owned by the process user and have no group or other permissions. Its parent directory must also be private.

```json
{
  "schemaVersion": "factory.pool-process.v1",
  "installationId": "installation-01",
  "poolId": "local-pool-01",
  "hostname": "127.0.0.1",
  "port": 9443,
  "database": {
    "credentialsPath": "/run/ezharness/factory-pool/database.json",
    "expectedDatabase": "factory_pool",
    "expectedRole": "factory_pool"
  },
  "tls": {
    "privateKeyPath": "/run/ezharness/factory-pool/server.key",
    "certificatePath": "/run/ezharness/factory-pool/server.pem",
    "caPath": "/run/ezharness/factory-pool/ca.pem"
  },
  "tokens": {
    "issuer": "ezharness-factory",
    "audience": "factory-pool",
    "publicKeyPaths": {
      "current": "/run/ezharness/factory-pool/token-current.pem"
    }
  },
  "identities": {
    "tenants": {
      "installation-tenant": {
        "tenantId": "tenant-01",
        "tokenSubject": "installation-01"
      }
    },
    "supervisors": {}
  },
  "resources": {
    "capacities": {
      "cpu": 16,
      "memory": 65536
    },
    "gpuHosts": []
  },
  "readinessFilePath": "/run/ezharness/factory-pool/readiness.json",
  "readinessHeartbeatMs": 5000
}
```

The database credential file has one field:

```json
{"databaseUrl":"postgresql://ROLE:PASSWORD@HOST:5432/factory_pool"}
```

Provision the database and role before process startup. The process checks `current_database()` and `current_user` against the configuration before it creates the additive pool schema. It then binds that database to the exact installation and pool IDs. A later process with different IDs fails closed.

`resources.capacities` accepts `cpu`, `memory`, and `provider`. GPU capacity comes only from the explicit `gpuHosts` list. A restart can add resources or increase capacity. It cannot remove a durable resource or GPU host. It cannot reduce capacity below live allocations or tenant minima. This rule retains queued work and live allocations during restart.

Each tenant or supervisor key is an allowed client certificate common name. Its signed RS256 token must match the configured subject, issuer, audience, and exact pool scopes. Supervisors can name only GPU hosts in `resources.gpuHosts`.

The readiness file uses schema `factory.pool-readiness.v1`. Consumers must call `readFactoryPoolReadiness` with the expected installation, pool, path, and heartbeat. The reader accepts only a fresh `ready` record whose database, schema, and listener fields are all true. Startup writes `starting`. A runtime probe failure writes `degraded` after the listener stops. `SIGINT` or `SIGTERM` stops the listener, closes PostgreSQL, and writes `stopped`.

The process writes no configuration or credential values to standard output or standard error. Startup errors contain only a phase code. The service manager should restart on a nonzero exit and should use the readiness reader for traffic admission.
