# @crawlertoll/fastify

Fastify plugin for the AI-crawler economy. One `register()` call wires up bot detection, Web Bot Auth verification, RSL 1.0 policy enforcement, and HTTP 402 issuance with a structured payment offer.

- **License**: Apache-2.0
- **Fastify**: 4.x or 5.x (peer dependency)
- **Node**: 20+
- **Core**: [`@crawlertoll/core`](https://www.npmjs.com/package/@crawlertoll/core) — all the standards work happens there; this package is the thin Fastify bridge.

[![npm](https://img.shields.io/npm/v/%40crawlertoll%2Ffastify.svg)](https://www.npmjs.com/package/@crawlertoll/fastify)
[![license](https://img.shields.io/npm/l/%40crawlertoll%2Ffastify.svg)](./LICENSE)

---

## Install

```bash
npm install @crawlertoll/fastify @crawlertoll/core fastify
```

---

## Sixty seconds

```ts
import Fastify from "fastify";
import crawlertoll from "@crawlertoll/fastify";

const app = Fastify();

await app.register(crawlertoll, {
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
  },
  contextLicenseUrl: "https://example.com/.well-known/context-license.json",
  termsUrl: "https://example.com/ai-terms",
});

app.get("/", async () => "hello");

await app.listen({ port: 3000 });
```

Any AI crawler hitting your endpoints gets a 402 with Cloudflare-shape `Crawler-Price` headers and a JSON payment offer. Browsers pass through. The plugin is wrapped in `fastify-plugin` so the request decoration is visible from the parent scope — no encapsulation gotchas.

---

## With an RSL 1.0 policy

The plugin accepts your robots.txt body directly. Policy is parsed once on first request, then cached.

```ts
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import crawlertoll from "@crawlertoll/fastify";

const app = Fastify();

const robotsTxt = readFileSync("./public/robots.txt", "utf8");

await app.register(crawlertoll, {
  policy: robotsTxt,
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
    paymentUrl: "https://pay.example.com/abc",
  },
});
```

Your `robots.txt`:

```
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
Allow: /public
License: https://example.com/ai-license
Permits: ai-search, rag
Prohibits: ai-training
Compensation: per-crawl 5000 micros USD
Standard: RSL/1.0

User-agent: *
Disallow:
```

Behaviour:

- GPTBot or ClaudeBot hits `/articles` → **402** with the payment offer (Disallow + Compensation = charge)
- GPTBot hits `/public/anything` → **200** (Allow override)
- Random browser → **200** (`*` catch-all is Disallow:)

---

## Per-request decision API

The plugin decorates the Fastify request with `request.crawlertoll`. The `FastifyRequest` type is augmented via module declaration, so handlers get TypeScript-typed access automatically:

```ts
app.get("/articles/:id", async (request, _reply) => {
  const decision = request.crawlertoll;
  if (decision?.bot.isBot) {
    request.log.info(
      { operator: decision.bot.entry?.operator, action: decision.action },
      "crawler decision",
    );
  }
  return { id: (request.params as { id: string }).id };
});
```

The decoration runs in the `onRequest` hook — the earliest lifecycle hook — so it's available in every subsequent hook (`preHandler`, `preValidation`, route handlers, `onResponse`, error handlers).

---

## All options

```ts
register(crawlertoll, {
  /** Payment offer surfaced when the decision is 402. */
  offer?: PaymentOffer,

  /** RSL 1.0 policy. Pass parsed `RslPolicy` or raw robots.txt text. */
  policy?: RslPolicy | string,

  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string,

  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string,

  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean,

  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean,

  /** Called after every decision. Telemetry hook. */
  onDecision?: (decision, request, reply) => void | Promise<void>,

  /** Short-circuit the decision pipeline. */
  decisionOverride?: (request) => Decision | null | Promise<Decision | null>,

  /** Pass-through options to build402(). */
  buildOptions?: Omit<Build402Options, "offer">,
})
```

---

## Telemetry hook

`onDecision` fires on every request after the decision is reached. Best-effort: errors are logged via `request.log.warn()` and swallowed so telemetry can never break a request.

```ts
await app.register(crawlertoll, {
  offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
  onDecision: (decision, request, _reply) => {
    metrics.increment("crawler.decision", {
      action: decision.action,
      operator: decision.bot.entry?.operator ?? "unknown",
      verified: decision.authVerified?.valid ?? false,
      route: request.routeOptions?.url ?? "unknown",
    });
  },
});
```

---

## Encapsulation note

This plugin is wrapped in [`fastify-plugin`](https://github.com/fastify/fastify-plugin) so the `request.crawlertoll` decorator and the `onRequest` hook apply to the parent scope (not just the encapsulated context). That is the right default — you almost always want crawler enforcement to apply to your entire app, not just a sub-tree.

If you want the plugin to apply to a specific encapsulated scope only (e.g. only routes under `/api/*`), wrap it yourself:

```ts
app.register(async (scoped) => {
  await scoped.register(crawlertoll, { /* options */ });
  scoped.get("/", async () => "scoped");
}, { prefix: "/api" });
```

---

## Conformance

8 `fastify.inject()` end-to-end tests cover:

- Browser request passes through
- Known bot → 402 with correct headers + body
- Bot allow-list (no offer configured) → 200
- `request.crawlertoll` decorated on every request
- RSL policy: blocked → 403, charge model → 402, Allow override → 200
- `onDecision` telemetry hook called for every request
- `decisionOverride` short-circuits the pipeline

Run them:

```bash
git clone https://github.com/charthouse-ltd/crawlertoll-fastify-js
cd crawlertoll-fastify-js
npm install
npm test
```

---

## Compatible frameworks

This package is the Fastify plugin. Other framework adapters use the same `@crawlertoll/core` engine — semantics are identical, only the request/response shim differs.

- `@crawlertoll/express` (Node, Express 4 + 5)
- `@crawlertoll/fastify` (this package — Fastify 4 + 5)
- `@crawlertoll/hono` (CF Workers, Bun, Deno, Vercel Edge, Node)
- `@crawlertoll/next` (forthcoming — Next.js `middleware.ts`)

If your framework isn't listed, use `@crawlertoll/core`'s `decide()` directly — it's framework-agnostic.

---

## License

[Apache-2.0](./LICENSE). All specs implemented are open standards under their own licenses.

## Trademark

CrawlerToll™ is a trademark of Charthouse Ltd.
