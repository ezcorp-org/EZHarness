# Manage Incus sandboxes

This flow uses the native EZHarness agent loop and an Incus guest workspace. The first version creates an empty sandbox project. It does not copy an existing AMD checkout or clone a repository automatically.

## Operator setup

1. Install, review, and activate the Incus provider in **Extensions**.
2. Open **Set up Incus**. Review the server plan, apply it, and check the connection.
3. Open the Incus management page at `/extensions/incus-management` and select the environment. Review and apply its host capacity plan. The server must have enough capacity for the selected preset.
4. Review the environment's test fixture plan and run qualification. Qualification can restart the isolated test app. Keep the saved run identity when reconnecting.
5. Check the saved qualification result and clean up its test fixtures. A connection probe alone does not qualify the environment.

The host still needs its reviewed SSH connection, certificate pins, image recipe, and qualification supervisor configuration. These are operator settings. The page cannot grant itself host access or replace the provider review step.

## Create and use a sandbox

Choose a qualified environment and enter a new project name. Check the preset's memory, CPU, and disk limits, then create the sandbox project. EZHarness creates the project, its owner membership, quota, and sandbox binding together. It does not create a local project folder first.

Start the sandbox and open its chat. Project file and shell tools use the guest workspace. A stopped, unavailable, or unconfirmed sandbox refuses project work; it must not fall back to AMD execution.

Stop the sandbox to release compute while keeping its workspace. Start it again to resume work. Destroy removes the workspace and requires an explicit confirmation. Save required work before destruction.

## When an action does not finish

Refresh the saved status. An unknown outcome can mean that Incus accepted the operation but its reply was lost. Use reconciliation for the existing operation. Do not submit another CREATE with a new identity to clear an unknown outcome.

The screen shows saved controller state. New actions recheck release approval, connection revision, qualification, scope, and quota. An expired or changed qualification requires another qualification run.

## Validation boundary

Browser tests with mocked provider APIs prove the screen's behavior. Real guest tests prove the installed provider path. Keep these results separate. See [the active task ledger](../tasks/todo.md) for completed checks and remaining live gates. Automatic repository bootstrap, authenticated preview controls, and guest process-log browsing need their own completed integration before they can be advertised here.
