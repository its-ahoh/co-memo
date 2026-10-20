# Enterprise design package

Tracking issue: https://github.com/its-ahoh/co-memo/issues/19

- [Design and explicit review](design.md): source audit, models, authorization, concurrency, lifecycle, SDK/MCP, migration and milestone acceptance.
- [PostgreSQL schema seed](schema.sql): full domain blueprint, not an applied production migration. M1 should implement only its required subset plus explicit role grants and tests.
- [M1 OpenAPI](openapi.json): create/list/get/update Context contract. Later endpoints are specified in the design and added as each milestone begins.

Review authorizes starting M1 development only. Production readiness, real-DB schema validation, service behavior and security tests remain implementation gates. The review is a self-review, not an independent audit. No local memories or credentials are included.
