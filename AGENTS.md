# Agent Guidelines for dsh-graph Repository

## Generated File Policy

### `dsh-graph-host/core/*.js` (compiled core)

These are compiled from `core/*.ts` and are **tracked in git** — GitHub source installs
(`github:owner/repo`) do not run prepack, so the plugin would fail to load without them.

- `core/*.ts` is the single source of truth. Never edit `dsh-graph-host/core/*.js` by hand.
- After changing `core/*.ts`, run `bash scripts/sync-core.sh` and **commit the regenerated
  `dsh-graph-host/core/*.js` together with the source**.
- `core-dist/` is a build intermediate and stays gitignored.

### `dsh-graph-host/lib/client.js`

This file is **auto-generated** and must **NOT** be edited directly.

#### Why?
- `dsh-graph-host/lib/client.js` is assembled from modular source files by `scripts/build-client.sh`
- Direct editing will be overwritten on next build
- Maintains consistency between source modules and final bundle

#### How to modify client code:
1. Edit the source modules in `dsh-graph-host/lib/client/*.js`
2. Run the build script: `bash scripts/build-client.sh`
3. Verify the generated file reflects your changes

#### Build Command
```bash
bash scripts/build-client.sh
```

#### Source Module Location
`dsh-graph-host/lib/client/*.js`

### Verification
After modifying source modules and rebuilding:
1. Run `node --check dsh-graph-host/lib/client.js` to verify syntax
2. Run the full test suite: `node --test core/tests/*.test.ts`
3. Ensure the generated file contains the `⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY` marker

## Development Workflow

1. **Always work with source modules** — never edit `dsh-graph-host/lib/client.js` directly
2. **Rebuild after changes** — run `bash scripts/build-client.sh`
3. **Verify compatibility** — ensure ModuleLoader contract and all tests pass
4. **Commit source modules and generated file** — commit changes to `dsh-graph-host/lib/client/*.js` **and** the rebuilt `dsh-graph-host/lib/client.js`

## Worktree Naming

Use a stable, auditable name for every isolated attempt worktree:

```text
.worktrees/g-<goal-number>-att-<NN>
```

Examples: `.worktrees/g-125-att-03`, `.worktrees/g-163-att-03`.

- `<NN>` is the zero-padded attempt number for that goal.
- The worktree branch should use the same suffix, such as `g-125-att-03`.
- Do not use ambiguous names such as `.worktrees/att-003`, `.worktrees/g165-att001`, or names that omit the goal id.
- Existing active/review worktrees are not renamed automatically; apply this convention to new attempts and explicit follow-up work.

## Isolated Dev/Test dsh Instance (two profiles)

Development and verification run in a profile that is **fully isolated** from the main
dsh, so an in-progress plugin can never break the production GUI.

- **Main web profile** (`dsh --profile web`, port 3080) uses the **published** `dsh-graph`
  npm package.
- **Test profile** (`dsh --profile dsh-graph-test`, port 3082) binds the **local**
  `dsh-graph-host` via `link:` — live dev/verification always happens here.
- The two are switched and managed by `scripts/dev-dsh-instance.sh` (self-contained,
  idempotent, default values overridable via env vars):

```sh
bash scripts/dev-dsh-instance.sh run [--port N] [--host H] [--open]  # setup + start test instance (default 3082)
bash scripts/dev-dsh-instance.sh setup            # create/install profile only, don't start
bash scripts/dev-dsh-instance.sh main-published   # point main profile at published dsh-graph (^0.6.1) + reinstall
bash scripts/dev-dsh-instance.sh main-dev         # point main profile back at local link: dev host
bash scripts/dev-dsh-instance.sh status           # show both profiles' dsh-graph dep + port usage
```

### Development loop

- **Node-side changes** (`dsh-graph-host/index.js`, `core/*.js`, `cordis.patch.yml`):
  the test profile references the host via `link:`, so re-running `run` picks up the
  latest source — no reinstall needed (`setup` is just idempotent write + `pnpm install`).
- **Browser/kanban changes** (`dsh-graph-host/lib/client/*.js`): these are source modules.
  Per the Generated File Policy above, never edit `lib/client.js` directly. Rebuild the
  generated bundle and refresh the **test instance (3082)** page:

```sh
bash scripts/build-client.sh
node --check dsh-graph-host/lib/client.js
node --test core/tests/*.test.ts
```

  dsh-graph's own client bundle has no live-reload watcher, so it's "rebuild + refresh".
- **Test instance isolation:** `.dsh-graph` data lives under `~/.dsh/dev-workspace/dsh-graph-test/.dsh-graph`,
  separate from the main repo's data — the g-149 canonical root logic does not merge these.
- **Main profile:** only switched via `main-published` / `main-dev`. After switching, the
  main GUI (3080) must be restarted/refreshed to load the new version. Always verify in the
  test instance first, then switch the main profile.

## Important Notes

- The generated file maintains the `window.__ModuleLoader__.load` contract required by the dsh client
- The generated marker is added at the top of the file before any module content
- This policy prevents accidental modification of generated code and ensures build consistency