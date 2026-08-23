# Agent Guidelines for dsh-graph Repository

## Generated File Policy

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
4. **Commit source modules** — commit changes to `dsh-graph-host/lib/client/*.js`, not the generated file

## Important Notes

- The generated file maintains the `window.__ModuleLoader__.load` contract required by the dsh client
- The generated marker is added after the initial comments but before the ModuleLoader call
- This policy prevents accidental modification of generated code and ensures build consistency