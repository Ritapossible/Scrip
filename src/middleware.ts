/**
 * Charge for an Express route in one line.
 *
 *   app.get("/haiku", requirePayment({ usd: "0.25" }), (req, res) => ...)
 *
 * An unpaid request gets a 402 carrying the price in USD, the FXRP amount it
 * converts to at the live FTSO rate, and everything needed to sign for it. A
 * request carrying a valid X-PAYMENT header is settled on chain and then handed
 * to the route as though it had been free.
 *
 * Quotes are stateless. The invoice id is an HMAC over (resource, amount,
 * deadline) keyed by a server secret, so when a payment comes back the service
 * can prove it issued that exact quote without having stored anything. That
 * matters for more than tidiness: an in-memory map of issued invoices would make
 * the service wrong behind a load balancer and forgetful across a restart, and
 * both failures look like a client that paid and got nothing.
 */

import { createHmac, randomBytes } from "node:crypto";
import { keccak256, toHex, formatUnits, getAddress, type Address, type Hex } from "viem";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Facilitator } from "./facilitator.js";
import {
  readFeed,
  resolveFtsoV2,
  assertFresh,
  usdToTokenAmount,
  parseUsd,
  XRP_USD_FEED_ID,
} from "./ftso.js";
import {
  X402_VERSION,
  SCHEME,
  NETWORK,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  encodeHeader,
  decodeHeader,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
} from "./x402.js";

export interface RequirePaymentOptions {
  facilitator: Facilitator;
  /** Where the money goes. */
  payee: Address;
  /** Price as a plain USD string, e.g. "0.25". */
  usd: string;
  description?: string;
  mimeType?: string;
  /** How long a quote stays payable. Also the signature deadline. */
  timeoutSeconds?: number;
}

/**
 * Signing key for invoice ids. Set SCRIP_INVOICE_SECRET in production: without
 * it every restart invalidates quotes that are still in flight, and a client
 * that was midway through paying gets a confusing rejection.
 */
const INVOICE_SECRET: string = (() => {
  const fromEnv = process.env.SCRIP_INVOICE_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const generated = randomBytes(32).toString("hex");
  console.warn(
    "  warning: SCRIP_INVOICE_SECRET is not set. Using a per-process random key, " +
      "so quotes issued before a restart will be rejected after it.",
  );
  return generated;
})();

/**
 * Bind a quote to its terms. A client cannot move the amount, the deadline or
 * the resource without producing an invoice id it has no way to compute.
 */
function invoiceIdFor(resource: string, amount: bigint, deadline: bigint): Hex {
  const mac = createHmac("sha256", INVOICE_SECRET)
    .update(`${resource}|${amount}|${deadline}`)
    .digest("hex");
  return keccak256(toHex(mac));
}

function resourceUrl(req: Request): string {
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}${req.baseUrl}${req.path}`;
}

export function requirePayment(opts: RequirePaymentOptions): RequestHandler {
  const {
    facilitator,
    payee,
    usd,
    description = "Paid resource",
    mimeType = "application/json",
    timeoutSeconds = 600,
  } = opts;

  const usdMicros = parseUsd(usd);
  const payeeAddress = getAddress(payee);

  return async function payWithScrip(req: Request, res: Response, next: NextFunction) {
    const resource = resourceUrl(req);

    try {
      const header = req.get(PAYMENT_HEADER);

      // --- unpaid: quote it ------------------------------------------------
      if (!header) {
        res.status(402).json(
          await buildChallenge({
            facilitator,
            resource,
            usdMicros,
            usd,
            payee: payeeAddress,
            description,
            mimeType,
            timeoutSeconds,
            error: `payment required: $${usd} in FXRP`,
          }),
        );
        return;
      }

      // --- paid: check it, then settle it ----------------------------------
      let payload: PaymentPayload;
      try {
        payload = decodeHeader<PaymentPayload>(header);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }

      const intent = payload?.payload?.intent;
      if (!intent) {
        res.status(400).json({ error: "payment payload is missing its intent" });
        return;
      }

      // Recomputing the invoice id is what proves this service issued the quote
      // being paid, and that the amount and deadline are the ones it named.
      let expectedInvoiceId: Hex;
      try {
        expectedInvoiceId = invoiceIdFor(resource, BigInt(intent.amount), BigInt(intent.deadline));
      } catch {
        res.status(400).json({ error: "intent amount or deadline is not a valid integer" });
        return;
      }

      if (expectedInvoiceId.toLowerCase() !== String(intent.invoiceId).toLowerCase()) {
        res.status(402).json(
          await buildChallenge({
            facilitator,
            resource,
            usdMicros,
            usd,
            payee: payeeAddress,
            description,
            mimeType,
            timeoutSeconds,
            error:
              "invoice id does not match this resource, amount and deadline. " +
              "Quotes are bound to their terms; request a fresh one.",
          }),
        );
        return;
      }

      const verdict = await facilitator.verify(payload, {
        invoiceId: expectedInvoiceId,
        payee: payeeAddress,
      });
      if (!verdict.valid) {
        res.status(402).json({
          x402Version: X402_VERSION,
          error: verdict.reason ?? "payment did not verify",
        });
        return;
      }

      const result = await facilitator.settle(payload);
      if (!result.success) {
        res.status(402).json({
          x402Version: X402_VERSION,
          error: result.error ?? "settlement failed",
        });
        return;
      }

      res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeader(result));
      // The route may want to know who paid without decoding the header again.
      res.locals.payment = result;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function buildChallenge(args: {
  facilitator: Facilitator;
  resource: string;
  usdMicros: bigint;
  usd: string;
  payee: Address;
  description: string;
  mimeType: string;
  timeoutSeconds: number;
  error: string;
}): Promise<PaymentRequiredBody> {
  const { facilitator, resource, usdMicros, usd, payee, timeoutSeconds } = args;

  const [fxrp, ftsoV2, block] = await Promise.all([
    facilitator.fxrp(),
    resolveFtsoV2(facilitator.client),
    facilitator.client.getBlock(),
  ]);

  const reading = await readFeed(facilitator.client, ftsoV2);
  // Billing against a stalled feed is worse than refusing to bill.
  assertFresh(reading, block.timestamp);

  const amount = usdToTokenAmount(usdMicros, reading, fxrp.decimals);
  const deadline = block.timestamp + BigInt(timeoutSeconds);
  const invoiceId = invoiceIdFor(resource, amount, deadline);

  const requirements: PaymentRequirements = {
    scheme: SCHEME,
    network: NETWORK,
    maxAmountRequired: amount.toString(),
    priceUsd: usd,
    rate: {
      feedId: XRP_USD_FEED_ID,
      value: reading.value.toString(),
      decimals: reading.decimals,
      timestamp: reading.timestamp.toString(),
    },
    resource,
    description: args.description,
    mimeType: args.mimeType,
    payTo: payee,
    asset: fxrp.address,
    assetSymbol: fxrp.symbol,
    assetDecimals: fxrp.decimals,
    facilitator: facilitator.address,
    invoiceId,
    deadline: deadline.toString(),
    maxTimeoutSeconds: timeoutSeconds,
  };

  return {
    x402Version: X402_VERSION,
    error: `${args.error} (${formatUnits(amount, fxrp.decimals)} ${fxrp.symbol} at $${reading.price}/XRP)`,
    accepts: [requirements],
  };
}
