# Provider boundaries

Every external system sits behind an interface in this directory.

```text
Domain / application logic (modules/)
        ↓ depends on
Provider interface   (providers/<kind>/index.ts)
        ↓ implemented by
Provider adapter     (providers/<kind>/<vendor>.ts)
        ↓ calls
External service SDK / HTTP API
```

Rules:

- Vendor SDKs are imported **only** inside adapter files.
- Adapters translate vendor errors into `ProviderError` and never leak vendor types.
- Interfaces here are **provisional** in Phase 0. The owning phase finalizes each
  contract before its first adapter is written.
- Adapter selection happens once at startup from `AppConfig.providers`.

| Boundary        | Owning phase | Purpose                              |
| --------------- | ------------ | ------------------------------------ |
| `messaging`     | Phase 2      | Outbound/inbound SMS                 |
| `ai`            | Phase 2      | Classification, extraction, drafting |
| `calendar`      | Phase 3      | Availability and booking             |
| `crm`           | Phase 3      | Syncing lead and booking state       |
| `notifications` | Phase 3      | Alerting the business owner          |
