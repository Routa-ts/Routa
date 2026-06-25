# AGENTS.md

## What This Repository Is

This docs folder holds **planning and design** for **Routa**: a schema-first, OpenAPI-aware REST framework for new TypeScript APIs ([README](./README.md)). v0 is Hono-based, Zod-only, and centered on OpenAPI-to-source plus source-to-OpenAPI contract flow.

**Where to look:** [README](./README.md), [v0_requirements.md](./v0_requirements.md), and [specs/README.md](./specs/README.md) for the current validation target; [backend_framework_design.md](./backend_framework_design.md), [middleware_design.md](./middleware_design.md), and [security_design.md](./security_design.md) for subsystem decisions; [http_contract_group1_wrapup.md](./http_contract_group1_wrapup.md) and [rest_backend_framework_checklist.md](./rest_backend_framework_checklist.md) for HTTP contracts and implementation scope.

## Conversation Workflow

1. Define the review groups first.
2. Pick one group and break it into small parts.
3. Ask questions only for the current part.
4. Work back and forth on decisions for that part.
5. Do not write design files until the user explicitly says: `Write it`.
6. Keep design files short and precise.
7. Update status files after decisions are written.
