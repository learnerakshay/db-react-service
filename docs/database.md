# Database

PostgreSQL via Prisma ORM 7 with the `@prisma/adapter-pg` driver adapter.

## Layout

- `prisma/schema.prisma` — generator + datasource. **No models in Phase 0.**
- `prisma.config.ts` — CLI config: schema path, migrations path, `DATABASE_URL`
  (loaded from the root `.env` when present).
- `apps/api/src/generated/prisma/` — generated client (git-ignored, regenerated on `npm install`).
- `apps/api/src/db/client.ts` — the only place a `PrismaClient` is constructed.

## Migration workflow

| Situation                            | Command                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| Change schema during development     | `npm run db:migrate` (`prisma migrate dev --name <change>`) |
| Regenerate client only               | `npm run db:generate`                                       |
| Apply committed migrations (CI/prod) | `npm run db:deploy`                                         |
| Inspect state                        | `npm run db:status`                                         |

Rules:

- Every schema change ships as a committed migration in `prisma/migrations/`.
- Never edit an applied migration; add a new one.
- Never use `prisma db push` against shared or production databases.
- Production applies migrations with `db:deploy` before the new API version starts.

## Connectivity

`GET /ready` runs `SELECT 1` through the Prisma client (5s connection timeout):

- `200 {"status":"ready","checks":{"database":"up"}}`
- `503` with `"down"` (unreachable) or `"not_configured"` (no `DATABASE_URL`)

The API shuts down cleanly on `SIGINT`/`SIGTERM`, disconnecting Prisma after the
HTTP server stops accepting connections.

## Test database strategy

- Unit and HTTP tests (all tests in Phase 0) use injected fakes and need no database.
- From Phase 1, database-backed tests run against a **separate** database,
  e.g. `cadentor_test`, supplied as `DATABASE_URL` in the test environment — never
  the development database.
- Prepare it with `prisma migrate reset --force` (or `db:deploy` on a fresh
  database) before the suite; tests isolate data per test (transaction rollback or
  truncation) so runs are deterministic and order-independent.
- CI provisions an ephemeral PostgreSQL service with the same major version as production.
