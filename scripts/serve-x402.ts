/**
 * The x402 facilitator service, and a paid endpoint that uses it.
 *
 *   npm run serve:x402
 *
 * Two things run here, and they are deliberately separable:
 *
 *   - the facilitator endpoints (/supported, /verify, /settle), which any
 *     resource server can point at without running its own relayer or holding
 *     a key;
 *   - a demo resource (/api/haiku) that charges $0.25 through the middleware,
 *     to show what "charge for a route in one line" actually looks like.
 *
 * In a real deployment these would be separate processes - the facilitator holds
 * a funded relayer key and the resource server does not need one. They share a
 * process here so the whole rail can be demonstrated with a single command.
 *
 * Two things about startup exist for hosted deployments specifically. The port
 * is opened before any chain work is done, and a configuration error becomes a
 * 503 that names itself rather than an exit. Both are because a platform health
 * check can only observe whether the port answers: a process that dies during
 * construction, or that spends a minute on a cold RPC before it listens, both
 * report as "healthcheck failure" and neither says which one happened.
 */

import "dotenv/config";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { getAddress, type Address, type Hex } from "viem";
import { Facilitator } from "../src/facilitator.js";
import { requirePayment } from "../src/middleware.js";
import { resolveFtsoV2, readFeed, XRP_USD_FEED_ID } from "../src/ftso.js";
import { SCHEME, NETWORK, X402_VERSION } from "../src/x402.js";
import { txUrl } from "../src/chain.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") {
    throw new Error(
      `${name} is not set. Locally, run npm run setup. On a hosting platform, ` +
        `set ${name} in the service's environment variables - see DEPLOY.md.`,
    );
  }
  return value;
}

/**
 * Read a private key from the environment, forgiving the things a value picks up
 * on its way through a hosting dashboard and naming the things it cannot.
 *
 * viem answers a wrapping quote, a trailing newline, a missing 0x and a
 * truncated paste with one sentence - "invalid private key, expected hex or 32
 * bytes, got string" - which is true of all four and useful for none. Three of
 * them are recoverable without guessing at intent, so they are recovered; what
 * is left is reported with the detail needed to fix it, and without putting any
 * part of the key in a log.
 */
function requiredKey(name: string): Hex {
  const raw = required(name)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();

  const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(
      `${name} is not a valid private key. Expected 64 hexadecimal characters, ` +
        `optionally 0x-prefixed; got ${body.length}. Check the variable for ` +
        `wrapping quotes, a trailing space or newline, or a paste that lost ` +
        `characters at either end.`,
    );
  }
  return `0x${body.toLowerCase()}` as Hex;
}

const PORT = Number(process.env.PORT ?? 8402);

// Railway injects its own hostname; used only to print an honest URL at boot.
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : undefined;

/**
 * What the startup check found. It runs after the port is open, so there is a
 * window where the service is listening and does not yet know whether it is
 * bound to the current FXRP. /health reports that state rather than guessing.
 */
type Readiness =
  | { state: "checking" }
  | { state: "ready"; asset: string }
  | { state: "broken"; error: string };

let readiness: Readiness = { state: "checking" };

/** The service proper. */
function buildApp(facilitator: Facilitator, payee: Address): Express {
  const app = express();
  app.use(express.json());

  // Behind Railway's proxy req.ip is the proxy unless this is set, which would
  // put every caller in one rate-limit bucket and let a single client lock out
  // the rest. One hop, not `true`: a permissive value lets a client spoof its
  // own IP through X-Forwarded-For and walk around the limiter entirely.
  if (process.env.TRUST_PROXY) app.set("trust proxy", 1);

  /**
   * The relayer pays gas for anything that settles, and this service is public,
   * so an unmetered /settle is an open invitation to drain it. The limit is
   * loose enough that a demo never touches it and tight enough that the relayer
   * survives being found by a bot.
   *
   * Only the two endpoints that cost something are limited. /health, /supported,
   * /price and /api/haiku stay open - those are what a reader actually hits, and
   * an unpaid /api/haiku only reads a price feed.
   */
  const spendLimiter = rateLimit({
    windowMs: 60_000,
    limit: 12,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      x402Version: X402_VERSION,
      error: "rate limited: this public facilitator caps settlement attempts per minute",
    },
  });

  // --- facilitator endpoints -------------------------------------------------

  app.get("/supported", (_req: Request, res: Response) => {
    res.json({
      x402Version: X402_VERSION,
      kinds: [{ scheme: SCHEME, network: NETWORK }],
      facilitator: facilitator.address,
      relayer: facilitator.relayer,
    });
  });

  /** Would this payment succeed? Costs nothing and settles nothing. */
  app.post("/verify", spendLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await facilitator.verify(req.body?.paymentPayload ?? req.body));
    } catch (err) {
      next(err);
    }
  });

  /** Submit the payment. The relayer signs and pays the gas. */
  app.post("/settle", spendLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await facilitator.settle(req.body?.paymentPayload ?? req.body);
      res.status(result.success ? 200 : 402).json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- a resource that costs money -------------------------------------------

  const HAIKU = [
    "Ledger holds its breath",
    "a signature, then the coin",
    "moves without a fee",
  ];

  app.get(
    "/api/haiku",
    requirePayment({
      facilitator,
      payee,
      usd: "0.25",
      description: "One haiku about gasless payment",
    }),
    (_req: Request, res: Response) => {
      const payment = res.locals.payment as { transaction?: Hex; delivered?: string };
      res.json({
        haiku: HAIKU,
        paidWith: payment?.transaction ? txUrl(payment.transaction) : undefined,
      });
    },
  );

  // --- free endpoints ---------------------------------------------------------

  /**
   * Someone who pastes the bare URL should learn what this is and what to try
   * next, not read `Cannot GET /`. It is the first thing a stranger sees.
   */
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      service: "Scrip - machine-payable FXRP on Flare",
      description:
        "An x402 facilitator. Agents pay for API calls in FXRP, priced in USD at " +
        "the live FTSO rate, holding no gas token of their own.",
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: NETWORK,
      facilitator: facilitator.address,
      relayer: facilitator.relayer,
      status: readiness.state,
      tryThis: {
        quote: "GET /api/haiku - returns 402 with a live FTSO-priced invoice",
        price: "GET /price - the XRP/USD feed this service bills against",
        kinds: "GET /supported",
      },
      endpoints: {
        paid: ["GET /api/haiku ($0.25)"],
        facilitator: ["GET /supported", "POST /verify", "POST /settle"],
        free: ["GET /health", "GET /price"],
      },
      source: "https://github.com/Ritapossible/Scrip",
      site: "https://scrip-pay.vercel.app",
    });
  });

  /**
   * The platform health check hits this. It answers 200 while the startup check
   * is still running, because "still checking" is not a reason to kill a
   * deployment - a cold Coston2 RPC can take a while and the service is
   * genuinely up. It answers 503 only once the check has definitively failed,
   * which is a condition waiting cannot fix.
   */
  app.get("/health", (_req: Request, res: Response) => {
    const body = {
      ok: readiness.state !== "broken",
      status: readiness.state,
      facilitator: facilitator.address,
      relayer: facilitator.relayer,
      ...(readiness.state === "ready" ? { asset: readiness.asset } : {}),
      ...(readiness.state === "broken" ? { error: readiness.error } : {}),
    };
    res.status(readiness.state === "broken" ? 503 : 200).json(body);
  });

  /** The live rate, so the pricing on a 402 can be checked independently. */
  app.get("/price", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ftsoV2 = await resolveFtsoV2(facilitator.client);
      const reading = await readFeed(facilitator.client, ftsoV2);
      res.json({
        feedId: XRP_USD_FEED_ID,
        value: reading.value.toString(),
        decimals: reading.decimals,
        price: reading.price,
        timestamp: reading.timestamp.toString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // Express 4 needs the four-argument shape to recognise an error handler.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`  error: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}

/**
 * What runs when the service cannot be constructed at all - a missing key, an
 * address that will not parse. It exists so the reason is readable from the
 * deployed URL and the platform's logs, instead of the deploy dying silently
 * during module evaluation and reporting only that a health check failed.
 */
function buildDiagnosticApp(error: string): Express {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.status(503).json({ ok: false, status: "misconfigured", error });
  });

  app.use((_req: Request, res: Response) => {
    res.status(503).json({
      error,
      hint: "The service started but cannot run without this. See DEPLOY.md for the variables it needs.",
    });
  });

  return app;
}

/**
 * The facilitator's `token` is immutable, so one bound to a stale FXRP can never
 * be fixed, only redeployed. This still runs at startup - it just runs after the
 * port is open, so a slow answer costs a moment of "checking" rather than the
 * whole deployment.
 */
async function verify(facilitator: Facilitator): Promise<void> {
  try {
    await facilitator.assertBoundToCurrentFxrp();
    const fxrp = await facilitator.fxrp();
    readiness = {
      state: "ready",
      asset: `${fxrp.address} (${fxrp.symbol}, ${fxrp.decimals} decimals)`,
    };
    console.log(`  asset           ${readiness.asset}`);
    console.log(`\n  ready\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    readiness = { state: "broken", error: message };
    console.error(`\n  startup check failed: ${message}\n`);
  }
}

async function main(): Promise<void> {
  let facilitator: Facilitator | undefined;
  let app: Express;

  try {
    facilitator = new Facilitator({
      facilitator: getAddress(required("FACILITATOR_ADDRESS")),
      relayerKey: requiredKey("RELAYER_PK"),
      rpcUrl: process.env.RPC_URL,
    });
    const payee: Address = getAddress(process.env.PAYEE_ADDRESS ?? facilitator.relayer);
    app = buildApp(facilitator, payee);

    console.log(`\nScrip x402 facilitator - ${NETWORK}\n`);
    console.log(`  listening       ${PUBLIC_URL ?? `http://127.0.0.1:${PORT}`}`);
    console.log(`  facilitator     ${facilitator.address}`);
    console.log(`  relayer         ${facilitator.relayer}`);
    console.log(`  payee           ${payee}`);
    console.log(`  scheme          ${SCHEME}`);
    console.log(`\n  paid resource   GET /api/haiku   ($0.25)`);
    console.log(`  facilitator     GET /supported, POST /verify, POST /settle`);
    console.log(`\n  pay it with:    npm run agent\n`);
    console.log(`  checking the facilitator is bound to the current FXRP...`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    readiness = { state: "broken", error: message };
    app = buildDiagnosticApp(message);
    console.error(`\nScrip x402 facilitator - cannot start\n`);
    console.error(`  ${message}\n`);
    console.error(`  Listening anyway on ${PORT} so the reason is readable at /health.\n`);
  }

  // 0.0.0.0, not loopback: a container that binds 127.0.0.1 is unreachable from
  // outside itself, and the platform's health check sees a dead service.
  app.listen(PORT, "0.0.0.0", () => {
    // The port is open before any chain call is made, so the health check has
    // something to answer with while the check below runs.
    if (facilitator) void verify(facilitator);
  });
}

main().catch((err: unknown) => {
  console.error(`\nserver failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
