/**
 * @crawlertoll/fastify — Fastify plugin for the AI-crawler economy.
 *
 *   import Fastify from "fastify";
 *   import crawlertoll from "@crawlertoll/fastify";
 *
 *   const app = Fastify();
 *
 *   await app.register(crawlertoll, {
 *     offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
 *     contextLicenseUrl: "https://example.com/.well-known/context-license.json",
 *     termsUrl: "https://example.com/ai-terms",
 *   });
 *
 *   app.get("/", () => "hello");
 *   app.listen({ port: 3000 });
 *
 * Idiomatic Fastify plugin shape: wrapped in `fastify-plugin` so the
 * request decoration `request.crawlertoll` and the `onRequest` hook
 * apply to the parent encapsulation scope (otherwise they'd be lost
 * when register() returns).
 *
 * The decision happens in `onRequest` — the earliest lifecycle hook,
 * before body parsing. If the decision is `402` or `block`, the
 * response is sent inline and the request never reaches the route
 * handler. If `allow`, the hook returns and the lifecycle continues
 * normally with `request.crawlertoll` populated.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fp from "fastify-plugin";

import {
  decide,
  parseRobotsTxt,
  type Build402Options,
  type Decision,
  type DecideInput,
  type PaymentOffer,
  type RslPolicy,
} from "@crawlertoll/core";

declare module "fastify" {
  interface FastifyRequest {
    /** Decision the plugin reached for this request. */
    crawlertoll?: Decision;
  }
}

export interface CrawlerTollOptions {
  /** Payment offer to surface when the decision is 402. */
  offer?: PaymentOffer;
  /** Options forwarded to `build402()`. */
  buildOptions?: Omit<Build402Options, "offer">;
  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string;
  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string;
  /**
   * RSL 1.0 policy. Pass either an already-parsed `RslPolicy` or the raw
   * robots.txt body — the plugin parses it once on first request.
   */
  policy?: RslPolicy | string;
  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean;
  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean;
  /**
   * Called for every request after a decision. Telemetry hook. Errors
   * are caught and swallowed (telemetry must not break the request).
   */
  onDecision?: (
    decision: Decision,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => void | Promise<void>;
  /**
   * Hook to short-circuit the decision before any of the standard logic.
   * Return `null` to fall through; return a `Decision` to override.
   */
  decisionOverride?: (
    request: FastifyRequest,
  ) => Decision | null | Promise<Decision | null>;
}

const DEFAULT_OPTIONS: Required<
  Pick<CrawlerTollOptions, "verifyAuth" | "trustVerifiedBots">
> = {
  verifyAuth: true,
  trustVerifiedBots: false,
};

/**
 * The plugin. Exported as the default so callers can `app.register(crawlertoll, options)`.
 */
const plugin: FastifyPluginAsync<CrawlerTollOptions> = async (
  fastify: FastifyInstance,
  options,
) => {
  // Lazily resolve the policy on first request, then memoise.
  let resolvedPolicy: RslPolicy | undefined;
  let policyResolved = false;
  const resolvePolicy = (): RslPolicy | undefined => {
    if (policyResolved) return resolvedPolicy;
    policyResolved = true;
    if (typeof options.policy === "string") {
      const { policy } = parseRobotsTxt(options.policy);
      resolvedPolicy = policy;
    } else if (options.policy) {
      resolvedPolicy = options.policy;
    }
    return resolvedPolicy;
  };

  const cfg = { ...DEFAULT_OPTIONS, ...options };

  // Decorate the request type so `request.crawlertoll` exists from the
  // first hook onwards. Decorating with `undefined` is the canonical
  // pattern — Fastify performs the V8-shape optimisation off this.
  fastify.decorateRequest("crawlertoll", undefined);

  fastify.addHook("onRequest", async (request, reply) => {
    const decision = await runDecision(request, cfg, resolvePolicy);
    request.crawlertoll = decision;

    if (options.onDecision) {
      Promise.resolve()
        .then(() => options.onDecision!(decision, request, reply))
        .catch((err: unknown) => {
          fastify.log.warn(
            { err: (err as Error).message },
            "crawlertoll onDecision threw",
          );
        });
    }

    if (decision.action === "allow") {
      return; // Lifecycle continues to next hook / handler.
    }
    if (decision.action === "402" && decision.built) {
      // Apply the structured 402 response.
      reply.code(decision.built.status);
      for (const [name, value] of Object.entries(decision.built.headers)) {
        reply.header(name, value);
      }
      return reply.send(decision.built.body);
    }
    if (decision.action === "block") {
      return reply.code(403).type("application/json").send({
        error: "forbidden",
        message: "Crawler access denied by site policy.",
        reasons: decision.reasons,
      });
    }
    // Unknown action — fall through.
  });
};

async function runDecision(
  request: FastifyRequest,
  cfg: CrawlerTollOptions & typeof DEFAULT_OPTIONS,
  resolvePolicy: () => RslPolicy | undefined,
): Promise<Decision> {
  if (cfg.decisionOverride) {
    const override = await cfg.decisionOverride(request);
    if (override) return override;
  }

  const headers = normaliseHeaders(request.headers);
  const policy = resolvePolicy();

  const buildOptions: Omit<Build402Options, "offer"> = {
    ...(cfg.contextLicenseUrl ? { contextLicenseUrl: cfg.contextLicenseUrl } : {}),
    ...(cfg.termsUrl ? { termsUrl: cfg.termsUrl } : {}),
    ...(cfg.buildOptions ?? {}),
  };

  const input: DecideInput = {
    request: {
      method: request.method,
      authority: getAuthority(request),
      targetUri: request.url,
      path: stripQuery(request.url),
      headers,
    },
    verifyAuth: cfg.verifyAuth,
    trustVerifiedBots: cfg.trustVerifiedBots,
    ...(policy ? { policy } : {}),
    ...(cfg.offer ? { offer: cfg.offer } : {}),
    ...(Object.keys(buildOptions).length ? { buildOptions } : {}),
  };

  return decide(input);
}

function normaliseHeaders(
  raw: FastifyRequest["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : String(v);
  }
  return out;
}

function getAuthority(request: FastifyRequest): string {
  const host = request.headers.host;
  if (host) return host;
  return request.hostname || "localhost";
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

// ─── fastify-plugin wrap so decorators escape encapsulation ─────────

export default fp(plugin, {
  fastify: "4.x || 5.x",
  name: "@crawlertoll/fastify",
});

// ─── Type re-exports for consumer ergonomics ───────────────────────

export type {
  Build402Options,
  Built402Response,
  PaymentOffer,
  SettlementRail,
  Decision,
  DecisionAction,
  RslPolicy,
} from "@crawlertoll/core";
