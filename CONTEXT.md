# EZHarness factory language

These terms describe the composable factory product planned within EZHarness. They do not rename existing workflow or extension concepts.

## Language

**Factory**:
A reusable definition of work, accepted output properties, and permitted release actions.
_Avoid_: workflow when the distinction from the existing workflow product matters.

**Factory version**:
An immutable published factory definition with its resolved dependency lock, acceptance contract, and interpreter compatibility version.
_Avoid_: current definition, latest definition when identifying a running factory.

**Logical run**:
The stable identity of one factory run across every Temporal execution, partition, and continuation.
_Avoid_: Temporal run ID, workflow ID.

**Interpreter**:
One Temporal workflow execution that hosts the kernel for one partition of a logical run.
_Avoid_: worker, run.

**Partition**:
A compiler-assigned subset of a run's node instances executed by one interpreter.
_Avoid_: subfactory, group.

**Candidate generation**:
A per-node-instance counter that increments on repair or replan; part of every operation ID and attempt token.
_Avoid_: attempt, iteration.

**Reducer**:
An ordinary Task node declared over a Map `collect` result. The kernel has no other merge.
_Avoid_: aggregate, merge step.

**Factory run**:
One execution of a factory version for a fixed input and authority context. It can contain many node instances and attempts.
_Avoid_: job, attempt.

**Node instance**:
One occurrence of a node in a run, including its map position and loop iteration.
_Avoid_: node ID alone when identifying expanded work.

**Attempt**:
One bounded execution try for a node instance. A retry preserves the logical work and does not create a new candidate.
_Avoid_: repair, iteration.

**Candidate**:
One immutable proposed output awaiting evaluation against an acceptance contract.
_Avoid_: accepted artifact before an acceptance decision exists.

**Repair**:
Work that creates a new candidate after an earlier candidate fails its acceptance contract.
_Avoid_: retry.

**Replan**:
A new validated strategy within the run's existing authority, linked to the work it replaces.
_Avoid_: mutation of completed history.

**Acceptance contract**:
The protected set of properties and evidence rules that an output must satisfy.
_Avoid_: prompt, test result.

**Evidence**:
A recorded claim about exact artifact content, attributed to a specific evaluator and evaluation conditions.
_Avoid_: ordinary log, confidence without a stated interpretation.

**Acceptance decision**:
The verdict for an exact artifact, contract, and evidence set. Acceptance does not grant release authority.
_Avoid_: release approval, universal correctness.

**Release operation**:
One authorized action that makes accepted content available at an external destination.
_Avoid_: acceptance, generation.

**Release approval**:
A person's permission for one exact release operation. Reusable automatic authority is a release policy.
_Avoid_: release policy when referring to a one-operation approval.

**Tenant**:
One customer organization and its isolated harness installation. A tenant can contain multiple projects and people.
_Avoid_: user, project.

**Tenant administrator**:
A person authorized to manage access and policy inside one tenant.
_Avoid_: platform operator.

**Platform operator**:
A person responsible for the hosted service infrastructure. This role does not itself grant product access or release consent.
_Avoid_: tenant administrator.

**Budget reservation**:
An amount withheld from a run's remaining allowance until its work is settled or its possible charge is resolved.
_Avoid_: actual charge, compute slot.

**Compute reservation**:
An exclusive allocation of execution capacity while work can still consume it.
_Avoid_: budget reservation.

**Installation**:
One deployed harness with its own product database, secrets, and Temporal namespace. A tenant has exactly one.
_Avoid_: instance when the hosted directory is meant.

**Control plane**:
The hosted service that provisions and operates installations and holds the tenant directory. It holds no product facts and grants no product access. A self-hosted installation has none.
_Avoid_: admin, operator console, host plane.

**Host plane**:
The trusted in-installation services: harness, execution gateway, orchestration process, and host supervisor.
_Avoid_: control plane.

**Pool admission service**:
The platform service, one per pool and a single in-installation process when self-hosted, that holds compute and provider capacity reservations keyed by opaque tenant IDs and assigns GPU hosts.
_Avoid_: scheduler, budget.

**Execution gateway**:
The per-installation trusted Bun service that journals operations, mints attempt tokens, and hosts the provider broker, release broker, fetch proxy, and archive writer roles.
_Avoid_: worker, supervisor.

**Provider broker**:
The gateway role that serves model, tool, and guarded network calls for runners under attempt tokens. Extends the v4 credential and network brokers.
_Avoid_: release broker, proxy.

**Release broker**:
The gateway role that performs publication and is the only holder of publish credentials. Extends the v4 pull-request broker.
_Avoid_: provider broker, adapter when the destination-specific code is meant.

**Host supervisor**:
The host-level daemon that launches, heartbeats, and kills isolated runners through the container runtime. It is the only factory component with container-runtime access and holds no tenant credentials or state.
_Avoid_: sandbox, gateway.

**Runner**:
One isolated Bun or Python process for one attempt, holding only attempt-scoped broker tokens. "Worker" is used only for a Temporal worker.
_Avoid_: worker, agent.

**Outbox dispatcher**:
The Node.js component that delivers product-side commands and decisions from the transactional outbox to Temporal with stable identities.
_Avoid_: scheduler, queue.

**Factory grant**:
One explicit row giving a principal one factory action in one project, with issuer, expiry, and revocation revision.
_Avoid_: role, scope.
