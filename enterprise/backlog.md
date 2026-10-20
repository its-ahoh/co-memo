# Remaining milestones (not started)

- M2: Entity/linking, authorized history API, conflict proposals/resolution, archive/restore/purge, content erasure including snapshots/receipts/derived stores, documented 410 replay, composite-FK and lifecycle race tests.
- M3: Handoff assignment, lease/fencing, heartbeat/cancel/takeover and atomic result completion; stale publisher and concurrent transition tests.
- M4: TypeScript SDK, opt-in enterprise MCP, retrieval/settings, explicit dry-run importer and parity evaluation. No automatic local upload or implicit fallback.
- M5: Human OIDC, administrative APIs, dead-letter inspection/replay, quotas/rate limiting, tenant scheduler, hardened TLS deployment, logging/metrics, backup/restore drill, migration upgrade/rollback operational procedure, load testing and independent security review/pilot.

Production gates still open: audited credential/membership administration, deployment secrets, abuse controls, HTTP/DB availability behavior, signal-driven shutdown under load, restore evidence, platform/major-version matrix and security review. The M1 self-review and local test results do not close these gates.
