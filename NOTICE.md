# Provenance and publication status

Co-memo has been rewritten as a TypeScript/Node.js local shared-memory tool. The former Rust CLI and its private-candidate/explicit-sharing workflow are no longer part of the active implementation. Existing databases are not migrated or deleted; the new implementation uses a separate database filename.

Earlier versions originated in Codey's memory engine. Its MIT copyright and permission notice remains preserved in [LICENSES/original-engine-MIT.txt](LICENSES/original-engine-MIT.txt).

The public license for new work remains undecided. `package.json` uses `UNLICENSED` and `private: true` to prevent accidental npm registry publication. Local packing and installation are supported. Public source hosting does not supersede existing license terms.

Runtime databases, generated projections, build output and dependency directories are excluded from version control. Tests contain synthetic notes only.
