# Internal hostless domain

`model.ts` owns document/frontmatter, managed-section and criteria transformations.
`machine.ts` owns transition validation and domain errors; its only dependency is
`model.ts`. Both implementations were extracted without behavior changes.

This directory is an internal module boundary, not a separately published package.
It must not import host services, Node built-ins, SDKs, GUI or prompt assets, or
read host identity/environment. Inputs remain explicit values; persistence and
Human Gate orchestration remain in their existing callers.

Existing consumers keep importing `core/model.ts` and `core/machine.ts`. Those
facades re-export the same objects (including error constructors). The build
copies compiled domain modules alongside the facades under `dist/core/domain/`.
The g393 domain tests guard dependency direction, compatibility and behavior.
