/**
 * Fastify plugin end-to-end test.
 *
 * Uses Fastify's `inject()` — synthetic in-process request that runs
 * the full lifecycle (hooks, decorators, handlers, error handlers)
 * without binding a port. Real-world parity is high; the same code
 * path runs under `app.listen()`.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import crawlertoll from "../src/index.js";

async function makeApp(
  opts: Parameters<typeof crawlertoll>[1] = {},
): Promise<FastifyInstance> {
  // Fastify's logger spams test output; silence by default.
  const app = Fastify({ logger: false });
  await app.register(crawlertoll, opts);
  app.get("/", async () => "ok");
  app.get("/articles/:id", async () => "article");
  app.get("/public/x", async () => "public");
  return app;
}

describe("@crawlertoll/fastify", () => {
  it("passes browser requests through", async () => {
    const app = await makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    await app.close();
  });

  it("returns 402 with crawler-price header to a known bot", async () => {
    const app = await makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      contextLicenseUrl: "https://example.com/.well-known/context-license.json",
      termsUrl: "https://example.com/ai-terms",
    });
    const res = await app.inject({
      method: "GET",
      url: "/articles/1",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.headers["crawler-price"]).toBe("5000 micros USD");
    expect(res.headers["crawler-price-rail"]).toBe("x402");
    const linkHeader = String(res.headers["link"] ?? "");
    expect(linkHeader).toContain('rel="describedby"');
    expect(linkHeader).toContain('rel="terms-of-service"');

    const body = res.json() as {
      error: string;
      offer: { rail: string; priceMicros: number };
    };
    expect(body.error).toBe("payment_required");
    expect(body.offer.priceMicros).toBe(5000);
    await app.close();
  });

  it("allows bots when no offer is configured (default-allow)", async () => {
    const app = await makeApp({});
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "user-agent": "ClaudeBot/2.0" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("decorates request.crawlertoll on every request", async () => {
    const captured: Array<unknown> = [];
    const app = Fastify({ logger: false });
    await app.register(crawlertoll, {
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    app.get("/", async (request) => {
      captured.push(request.crawlertoll);
      return "ok";
    });
    await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      },
    });
    expect(captured).toHaveLength(1);
    const decision = captured[0] as { action: string; bot: { isBot: boolean } };
    expect(decision.action).toBe("allow");
    expect(decision.bot.isBot).toBe(false);
    await app.close();
  });

  it("respects RSL policy passed inline as robots.txt text", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Allow: /public

User-agent: *
Disallow:
`;
    const app = await makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });

    const blocked = await app.inject({
      method: "GET",
      url: "/articles/1",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    // Disallow:/ with no Compensation → block (403)
    expect(blocked.statusCode).toBe(403);
    const body = blocked.json() as { error: string };
    expect(body.error).toBe("forbidden");

    const allowed = await app.inject({
      method: "GET",
      url: "/public/x",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("charges (402) when RSL declares per-crawl compensation", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Compensation: per-crawl 5000 micros USD
`;
    const app = await makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/articles/1",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(res.statusCode).toBe(402);
    await app.close();
  });

  it("calls onDecision telemetry hook for every request", async () => {
    const seen: string[] = [];
    const app = Fastify({ logger: false });
    await app.register(crawlertoll, {
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      onDecision: (decision) => {
        seen.push(decision.action);
      },
    });
    app.get("/", async () => "ok");
    await app.inject({
      method: "GET",
      url: "/",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)",
      },
    });
    // Give the best-effort hook a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["402", "allow"]);
    await app.close();
  });

  it("decisionOverride can short-circuit the decision", async () => {
    const app = Fastify({ logger: false });
    await app.register(crawlertoll, {
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      decisionOverride: () => ({
        action: "allow",
        bot: {
          isBot: true,
          entry: null,
          userAgent: "test",
          hasSignatureHeaders: false,
          signatureAgent: null,
          reasons: Object.freeze(["override"]),
        },
        reasons: Object.freeze(["override"]),
      }),
    });
    app.get("/", async () => "ok");
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "user-agent": "GPTBot/1.2" },
    });
    // Without override this would be 402; with override it's 200.
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
