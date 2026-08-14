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
import { getAddress, formatEther, parseEther, type Address, type Hex } from "viem";
import { Facilitator, FxrpBindingError } from "../src/facilitator.js";
import { requirePayment } from "../src/middleware.js";
import { readFeed, XRP_USD_FEED_ID } from "../src/ftso.js";
import { SCHEME, NETWORK, X402_VERSION, PAYMENT_HEADER } from "../src/x402.js";
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

/**
 * Addresses this facilitator will spend gas on behalf of, comma separated.
 * Unset means anyone, which is correct for a local run and wrong for a public
 * one - so the hosted deployment sets it to its own payee.
 */
function payeeAllowlist(): Address[] {
  const raw = process.env.SCRIP_PAYEE_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => getAddress(entry));
}

/**
 * Below this, the relayer is close enough to empty to be worth saying so. A
 * settlement costs roughly 200k gas, so this is a few hundred payments of
 * headroom rather than an emergency - the point is to be told before the demo
 * stops working, not after.
 */
const LOW_GAS_THRESHOLD = parseEther("1");

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
   * so an unmetered path to settlement is an open invitation to drain it.
   *
   * What gets metered is the cost, not the route. A request carrying X-PAYMENT
   * reaches `settle()` whether it arrives at POST /settle or at the priced
   * resource, so both cost the same allowance - limiting only the facilitator
   * endpoint left the identical spend reachable through the other door. Requests
   * that settle nothing are metered separately and far more loosely, because
   * they still cost RPC round trips and those are worth having a ceiling on too.
   *
   * `Retry-After` is the part a client can act on. The draft-7 `RateLimit`
   * header carries the same reset, but far more clients understand this one, and
   * a caller that cannot tell how long to wait retries immediately and stays
   * limited.
   */
  const limiter = (limit: number, note: string, only: "paid" | "unpaid" | "all") =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req: Request) => {
        if (only === "all") return false;
        const carriesPayment = Boolean(req.get(PAYMENT_HEADER));
        return only === "paid" ? !carriesPayment : carriesPayment;
      },
      handler: (_req: Request, res: Response) => {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ x402Version: X402_VERSION, error: `rate limited: ${note}` });
      },
    });

  const spendLimiter = limiter(
    12,
    "this public facilitator caps settlement attempts per minute",
    "all",
  );

  /**
   * A request carrying X-PAYMENT reaches settle() and spends the relayer's gas,
   * which is the thing worth metering - and metering it only on POST /settle
   * left the same spend reachable through the priced route, unmetered. The two
   * paths now cost the same allowance.
   */
  const paidRouteLimiter = limiter(
    12,
    "settlement attempts through this resource are capped per minute",
    "paid",
  );

  /**
   * An unpaid request settles nothing, but it does resolve the FTSO feed and read
   * a block to price a quote - three round trips to a public RPC, per request,
   * for anyone who asks. Loose enough that a reader never notices, tight enough
   * that the endpoint cannot be used to exhaust an RPC quota.
   */
  const quoteLimiter = limiter(60, "quote requests are capped per minute", "unpaid");

  /** Same reasoning as the quote limiter, for the reads that are not quotes. */
  const readLimiter = limiter(60, "price reads are capped per minute", "all");

  // --- facilitator endpoints -------------------------------------------------

  app.get("/supported", (_req: Request, res: Response) => {
    res.json({
      x402Version: X402_VERSION,
      kinds: [{ scheme: SCHEME, network: NETWORK }],
      facilitator: facilitator.address,
      relayer: facilitator.relayer,
      // Stated rather than discovered: a resource server pointing here should
      // know whether its payee will be served before it advertises a price.
      payeePolicy:
        facilitator.payeeAllowlist.length === 0
          ? "open - settles for any payee"
          : "allowlist",
      payees: facilitator.payeeAllowlist.length === 0 ? undefined : facilitator.payeeAllowlist,
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
    paidRouteLimiter,
    quoteLimiter,
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
  app.get("/health", async (_req: Request, res: Response) => {
    // The relayer pays for every settlement and nothing tops it up. An empty one
    // fails payments with a message about funds rather than about payments, so
    // the balance is reported where a monitor can watch it instead of being
    // something you remember to check.
    let gas: { relayerBalance: string; low: boolean } | undefined;
    try {
      const balance = await facilitator.client.getBalance({ address: facilitator.relayer });
      gas = {
        relayerBalance: formatEther(balance),
        low: balance < LOW_GAS_THRESHOLD,
      };
    } catch {
      // A health check that fails because an RPC hiccupped is worse than one
      // that answers without the balance.
    }

    const body = {
      ok: readiness.state !== "broken",
      status: readiness.state,
      facilitator: facilitator.address,
      relayer: facilitator.relayer,
      ...(gas ? { gas } : {}),
      ...(readiness.state === "ready" ? { asset: readiness.asset } : {}),
      ...(readiness.state === "broken" ? { error: readiness.error } : {}),
    };
    res.status(readiness.state === "broken" ? 503 : 200).json(body);
  });

  /** The live rate, so the pricing on a 402 can be checked independently. */
  app.get("/price", readLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ftsoV2 = await facilitator.ftsoV2();
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
async function verify(facilitator: Facilitator, attempt = 1): Promise<void> {
  try {
    await facilitator.assertBoundToCurrentFxrp();
    const fxrp = await facilitator.fxrp();
    readiness = {
      state: "ready",
      asset: `${fxrp.address} (${fxrp.symbol}, ${fxrp.decimals} decimals)`,
    };
    console.log(`  asset           ${readiness.asset}`);

    const gas = await facilitator.client.getBalance({ address: facilitator.relayer });
    console.log(`  relayer gas     ${formatEther(gas)} C2FLR`);
    if (gas < LOW_GAS_THRESHOLD) {
      console.warn(
        `  warning: the relayer holds ${formatEther(gas)} C2FLR. It pays for every ` +
          `settlement and nothing refills it.`,
      );
    }

    console.log(`\n  ready\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Only a binding mismatch is permanent. Everything else here is the network
    // - a cold public RPC, a DNS blip, a container that started before its
    // egress did - and treating those as fatal is how a deployment dies of a
    // hiccup: the service marks itself broken, answers 503 for good, and the
    // platform's health check fails a build that would have worked a second
    // later.
    if (err instanceof FxrpBindingError) {
      readiness = { state: "broken", error: message };
      console.error(`\n  startup check failed, and waiting will not help: ${message}\n`);
      return;
    }

    // Stays "checking", so /health keeps answering 200 while the chain is out of
    // reach. The service genuinely is up; it just cannot prove its binding yet.
    const delaySeconds = Math.min(30, 2 ** Math.min(attempt, 5));
    console.error(
      `  startup check attempt ${attempt} could not reach the chain, retrying in ` +
        `${delaySeconds}s: ${message.split("\n")[0]}`,
    );
    setTimeout(() => void verify(facilitator, attempt + 1), delaySeconds * 1000).unref();
  }
}

async function main(): Promise<void> {
  let facilitator: Facilitator | undefined;
  let app: Express;

  try {
    const allowlist = payeeAllowlist();
    facilitator = new Facilitator({
      facilitator: getAddress(required("FACILITATOR_ADDRESS")),
      relayerKey: requiredKey("RELAYER_PK"),
      rpcUrl: process.env.RPC_URL,
      payeeAllowlist: allowlist,
    });
    const payee: Address = getAddress(process.env.PAYEE_ADDRESS ?? facilitator.relayer);

    // A public facilitator that will pay gas for anyone's payee is one anybody
    // can drain at the rate limiter's pace. Worth a line at boot rather than a
    // paragraph in a document nobody reads twice.
    if (allowlist.length === 0) {
      console.warn(
        "  warning: SCRIP_PAYEE_ALLOWLIST is not set, so this facilitator will " +
          "pay gas for a payment to any payee. Fine locally; set it if this is public.",
      );
    }

    app = buildApp(facilitator, payee);

    console.log(`\nScrip x402 facilitator - ${NETWORK}\n`);
    console.log(`  listening       ${PUBLIC_URL ?? `http://127.0.0.1:${PORT}`}`);
    console.log(`  facilitator     ${facilitator.address}`);
    console.log(`  relayer         ${facilitator.relayer}`);
    console.log(`  payee           ${payee}`);
    console.log(
      `  payee policy    ${allowlist.length === 0 ? "open (any payee)" : `allowlist of ${allowlist.length}`}`,
    );
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
