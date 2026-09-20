# Memory inbox

Open the dashboard and select **Memory inbox**. It collects memories whose original source is an agent or execution, including file imports. Manually authored user notes remain in the library. The badge counts unread memory versions and unreviewed file changes, not pending memory approvals; reading a note never confirms or shares it.

Each card shows its assigned agent, timestamp, version, and available source (file path, conversation ID, or event ID). Open a card to mark that version read and inspect evidence/history, edit, confirm, share, or forget it. Read state is persisted in the local database and shared across dashboard tabs. A newer version becomes unread again. If an integration did not supply a task/conversation ID, the inbox cannot infer one.

Library views poll every five seconds while visible and idle. Polling pauses while an editor is open or a form input has focus. Errors do not clear the current view; use Refresh to explicitly retry. There are no desktop notifications or background browser notifications.

## Discover file changes

Under **Watched memory files**, enter an absolute `.md` path, assign a registered agent, and optionally select a project. Registration is an explicit instruction to read that file. Do not register files containing secrets. Ownership is configured by you; it does not prove who wrote a change.

File-system events trigger debounced scans of registered files. Startup and periodic reconciliation recover missed events. A changed file must have the same content hash in two consecutive scans before import. New or changed paragraphs become private lesson candidates with a source path and file hash. Long paragraphs are split into chunks of at most 2,400 characters. Exact duplicates follow engine deduplication rules. There are no semantic extraction calls, automatic confirmations, or changes to sharing.

The latest file snapshots appear under **Last file change**, showing Before and After. This is a snapshot comparison, not a semantic conflict resolver. An updated paragraph does not replace an older confirmed memory. Review both and forget the obsolete entry when appropriate. Cleared, deleted, and restored files produce their own versioned change notices with Added/Removed sections, even when no new memory was created. Mark reviewed acknowledges that file version only; it neither confirms nor forgets memories. Missing permissions, oversized content, or an archived owner appear as source errors; existing memories remain intact.

Pause or resume any source. Registrations and last imported snapshots survive a server restart; import requires either the dashboard server or the standalone watcher to be running. Initial registration imports the file's existing paragraphs, not just future edits. The first import after restart also waits for a stable snapshot. Source snapshots are retained in the local database and may contain sensitive text. The current JSON memory export does not include source registrations/snapshots or inbox read markers.

Limits: 32 registered files, each a regular UTF-8 Markdown file no larger than 64 KiB. Final-path symlinks are rejected. This is a trusted local administrator feature, not a filesystem security sandbox. There is no recursive directory scanning, Markdown writeback, cross-machine replication, or native client hook installation.

## Run without the dashboard

Register a file through the CLI (use stable agent/project IDs from `catalog`):

```sh
node dist/cli.js source-add --db /absolute/memory.sqlite --agent AGENT_ID --project PROJECT_ID --file /absolute/project/MEMORY.md
node dist/cli.js sources --db /absolute/memory.sqlite
node dist/cli.js watch --db /absolute/memory.sqlite
```

`watch` monitors all enabled registrations in that database, including files registered later through another process. It requires no HTTP server and makes no model calls. Events are the primary trigger; the default fallback reconciliation interval is 30,000 ms; `--interval` accepts 250–60,000 ms. `--once` defaults to two scan attempts 250 ms apart, then exits; changing or busy files may still need a later scan. Stop continuous watching with Ctrl+C or SIGTERM. This runs in the foreground; it does not install a system service.

Standard output is newline-delimited JSON with source IDs, paths, status, change kind, and added/removed counts. It omits file contents. `sources` is an administrative command and includes saved snapshots; avoid sending its output to untrusted clients.

The standalone watcher and dashboard share a short SQLite scan lease to prevent overlapping scans. A crashed scan's lease expires after 30 seconds. Atomic editor file replacements are picked up by parent-directory events and fallback scans. A temporary missing file must be missing in two consecutive scans before a deletion notice is recorded. Recreated content is checked again; deduplication prevents unchanged lessons from becoming duplicate memories.

To disable automatic imports while keeping the review UI open, start the server with `CO_MEMO_WATCH=0`. Use a host hook to invoke `watch --once` after writes complete. See [the two configuration modes](../README.md#file-access-and-import-modes) for setup and file-access authorization.
