# Central memory backup and restore

A backup captures the **entire selected central store**, across all projects and user memories. `--project` does not restrict its scope. Commands never contact a model or embedding provider.

## Create and verify

```sh
co-memo backup /path/to/new-backup-directory
co-memo backup-check /path/to/new-backup-directory
# For a non-default store:
co-memo --home /path/to/data backup /path/to/another-new-backup
```

The destination must not exist, and its parent must exist. Each archive contains a standalone SQLite snapshot and `manifest.json` with format/schema versions, creation time, SHA-256 and table counts. Directories are created with mode 0700, files with mode 0600. Treat archives as private memory data; they are not encrypted. The checksum detects accidental corruption, not authenticity against someone able to replace both files.

SQLite's online backup API captures committed WAL data consistently; simply copying the main live database file would not. The source is opened read-only without schema migration or Markdown synchronization. Active writers can cause SQLite to restart backup work, so prefer a quiet moment for large stores. Backups currently accept schemas 4, 5 and 6.

The snapshot retains memories, revisions, archived records and content-free permanent-deletion IDs, conflicts/resolutions, settings, project/worktree identities, submission retry records, connections and legacy replica bookkeeping and full-text index. Verification checks the checksum, SQLite integrity, agreement between the manifest and snapshot schema, required tables/counts, note payloads and index coverage. The manifest schema is read from the completed snapshot rather than the changing live database. It is a structural check, not a claim that the stored memories are factually correct.

**Not included:** pending edits in project Markdown, host configuration, embedding caches and disconnected-file archives. Save intended legacy edits through tools/CLI before backup. Backup itself deliberately does not import or resolve anything. Save external files separately when needed. Backup reads do not change pause or explicit-only settings.

## Restore into a new home

```sh
co-memo restore /path/to/backup --to /path/to/new-data
co-memo restore /path/to/backup --to /path/to/new-data --apply
```

The first command verifies and previews; it creates no destination. Apply requires a **non-existing directory**, even an existing empty directory is refused. There is no force-overwrite mode. On a handled failure, only the newly created destination is removed. A forcibly terminated process may leave an incomplete destination; choose another new directory when retrying.

Restoration preserves central data but removes agent connections and legacy replica registrations in the restored copy. This prevents old project Markdown from being silently imported or overwritten by the recovered store. It leaves the source backup, original store, project files and existing host bindings unchanged. Original project paths and explicit worktree links are preserved, not automatically remapped to another machine.

Inspect restored data before switching:

```sh
co-memo --home /path/to/new-data --project /path/to/project list
co-memo --home /path/to/new-data --project /path/to/project settings get
```

To switch a project, stop its agents first. Using the **old home**, disconnect each old agent with `disconnect AGENT --apply` to remove old bindings. Legacy Markdown files remain untouched. Then reconnect with the **new home**:

```sh
co-memo --home /path/to/new-data --project /path/to/project init --agents claude,codex --apply
```

Add `--hooks` if desired. Legacy files are ignored; preserve any unsaved edits separately. Restart hosts and confirm their memory tool results. Other projects continue using their old store until explicitly switched. If the original store is unavailable and disconnect cannot run, preserve local projections manually and rerun setup, which replaces managed bindings.

Historical deleted notes remain deleted as of the snapshot. Changes made after the snapshot are naturally absent: restoring an older snapshot cannot retain later deletions or corrections. Review restored content before adopting it. Rebuild optional embedding indexes explicitly if needed; restore does not send any text to a provider.
