-- Original TypeScript table definitions retained for migration tests.
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, audience TEXT NOT NULL,
        project_id TEXT, state TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_scope ON memories(owner_id, audience, project_id, state);
CREATE TABLE IF NOT EXISTS revisions (memory_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
        payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(memory_id, version));
CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learning_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox_seen(memory_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_sources(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_scan_lease(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
