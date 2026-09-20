# Provenance and publication status

The files under `src/engine/` were extracted from Codey's `packages/core/src/memory-engine/` and adapted for independent use, stable Agent identities, selected-agent sharing, and stage/purpose classification. The original source is covered by the MIT license retained at `src/engine/LICENSE`, including its copyright notice. They do not import Codey packages or configuration.

The new dashboard, catalog and standalone server were developed in this workspace. The project name is Co-memo. The public license for the new work has not yet been selected by the user. `package.json` therefore uses `UNLICENSED` and `private: true` to record the unresolved license and prevent npm publication; those fields do not remove or supersede the original engine's MIT terms.

The repository is intended for public source hosting. No npm package has been uploaded, and no real memories or credentials are included. Public visibility does not grant a license to the new work; the extracted engine retains its MIT license. Runtime SQLite databases, build output and dependency directories are excluded by `.gitignore`.
