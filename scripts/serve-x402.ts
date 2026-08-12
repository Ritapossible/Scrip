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
 */

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { getAddress, type Address, type Hex } from "viem";
import { Facilitator } from "../src/facilitator.js";
import { requirePayment } from "../src/middleware.js";
import { resolveFtsoV2, readFeed, XRP_USD_FEED_ID } from "../src/ftso.js";
import { SCHEME, NETWORK, X402_VERSION } from "../src/x402.js";
import { txUrl } from "../src/chain.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") {
    throw new Error(`${name} is not set in .env - run npm run setup first.`);
  }
  return value;
}

const PORT = Number(process.env.PORT ?? 8402);

const facilitator = new Facilitator({
  facilitator: getAddress(required("FACILITATOR_ADDRESS")),
  relayerKey: required("RELAYER_PK") as Hex,
  rpcUrl: process.env.RPC_URL,
});

const payee: Address = getAddress(process.env.PAYEE_ADDRESS ?? facilitator.relayer);

const app = express();
app.use(express.json());

// --- facilitator endpoints ---------------------------------------------------

app.get("/supported", (_req: Request, res: Response) => {
  res.json({
    x402Version: X402_VERSION,
    kinds: [{ scheme: SCHEME, network: NETWORK }],
    facilitator: facilitator.address,
    relayer: facilitator.relayer,
  });
});

/** Would this payment succeed? Costs nothing and settles nothing. */
app.post("/verify", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await facilitator.verify(req.body?.paymentPayload ?? req.body));
  } catch (err) {
    next(err);
  }
});

/** Submit the payment. The relayer signs and pays the gas. */
app.post("/settle", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await facilitator.settle(req.body?.paymentPayload ?? req.body);
    res.status(result.success ? 200 : 402).json(result);
  } catch (err) {
    next(err);
  }
});

// --- a resource that costs money ---------------------------------------------

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

// --- free endpoints -----------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, facilitator: facilitator.address, relayer: facilitator.relayer });
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

async function main(): Promise<void> {
  // Fail at startup rather than inside a demo: a facilitator bound to a stale
  // FXRP is immutable and can only be fixed by redeploying.
  await facilitator.assertBoundToCurrentFxrp();
  const fxrp = await facilitator.fxrp();

  app.listen(PORT, () => {
    console.log(`\nScrip x402 facilitator - ${NETWORK}\n`);
    console.log(`  listening       http://127.0.0.1:${PORT}`);
    console.log(`  facilitator     ${facilitator.address}`);
    console.log(`  relayer         ${facilitator.relayer}`);
    console.log(`  payee           ${payee}`);
    console.log(`  asset           ${fxrp.address} (${fxrp.symbol}, ${fxrp.decimals} decimals)`);
    console.log(`  scheme          ${SCHEME}`);
    console.log(`\n  paid resource   GET /api/haiku   ($0.25)`);
    console.log(`  facilitator     GET /supported, POST /verify, POST /settle`);
    console.log(`\n  pay it with:    npm run agent\n`);
  });
}

main().catch((err: unknown) => {
  console.error(`\nserver failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
