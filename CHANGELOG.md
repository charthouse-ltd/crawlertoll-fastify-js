# Changelog

All notable changes to `@crawlertoll/fastify` are documented here.

The package follows [Semantic Versioning](https://semver.org/) and tracks the `@crawlertoll/core` major version.

## [0.1.1] — 2026-05-21

### Changed

- Repository URL updated after the GitHub org rename `nhrzxxw9dn-web` → `charthouse-ltd` (npm scope unchanged: `@crawlertoll/*`). Metadata-only release; no code changes.

## [0.1.0] — 2026-05-19

Initial release. Ships alongside `@crawlertoll/core` v0.1.0, `@crawlertoll/express` v0.1.0, and `@crawlertoll/hono` v0.1.0.

### Added

- `register(crawlertoll, options)` Fastify plugin, wrapped in `fastify-plugin` so the request decoration and `onRequest` hook propagate to the parent encapsulation scope by default.
- Decision attached to `request.crawlertoll` via `decorateRequest` — TypeScript module augmentation gives typed access in handlers automatically.
- Supports inline RSL 1.0 policy via `options.policy: RslPolicy | string` (raw robots.txt is parsed once and cached).
- `onDecision` telemetry hook (best-effort; errors logged via `request.log.warn()` and swallowed).
- `decisionOverride` hook for whitelisted-internal-service patterns.
- `verifyAuth` (default true) and `trustVerifiedBots` (default false) toggles.
- Fastify 4.x and 5.x compatible (peer dependency).

### Conformance

- 8/8 vitest tests via Fastify's `inject()` synthetic-request harness.
- Re-uses `@crawlertoll/core`'s 47-test conformance suite indirectly through the decision engine.
- Decision identical (byte-for-byte) to `@crawlertoll/express` and `@crawlertoll/hono` for the same input — same core engine, same RSL/Web Bot Auth/HTTP 402 implementations.
