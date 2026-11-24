# Hitch

An open standard for clients of a headless agent backend: decisions, items, sessions, messages, feeds and clients over one REST face and one event stream. Haystack (the claude-extended mod pack) is the first implementation; Herdquarters is the first full client.

Status: **draft** (hitch/1). See [SPEC.md](SPEC.md).

| Path | What |
|---|---|
| [SPEC.md](SPEC.md) | the standard, including the normative wire details |
| [types/](types) | JSON Schemas for every hitch-owned type, resource and request |
| [codes.json](codes.json), [catalogue.json](catalogue.json) | refusal codes with HTTP status; types with owner, privacy, floor and safety |
| [conformance/](conformance/README.md) | `hitch-check` (nodes), `hitch-client-check` + `hitch-mock` (clients), `hitch-catalog-check` |

```sh
npm test   # the kit tests itself (about 2 s)
```
