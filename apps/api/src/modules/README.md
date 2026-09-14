# Modules

Domain/application modules live here, one directory per business capability
(e.g. `leads/`, `suppression/`, `campaigns/` from Phase 1 onward).

Each module owns its services, validation schemas and lifecycle transitions.
Modules receive dependencies (database, providers, job queue, logger) as
arguments; they never import Express, read `process.env`, or import vendor SDKs.

Empty in Phase 0 by design.
