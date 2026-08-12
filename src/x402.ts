/**
 * The x402 wire format, as this rail speaks it.
 *
 * x402 revives HTTP 402: the server answers an unpaid request with a price and
 * the terms of payment, the client pays, and retries the same request carrying
 * proof. The shape below follows the x402 spec's `accepts` / `X-PAYMENT` /
 * `X-PAYMENT-RESPONSE` structure.
 *
 * One deliberate deviation. Every x402 implementation in the wild is written
 * against USDC, whose EIP-3009 `transferWithAuthorization` names its recipient
 * inside the signed authorisation. FXRP implements EIP-2612 `permit`, which does
 * not - it commits only to (owner, spender, value, nonce, deadline). A permit
 * alone would let anyone who observed it settle naming themselves as payee, so
 * this scheme carries a second signature, a PaymentIntent, that names the
 * invoice, payee and amount. The scheme is therefore called
 * `exact-permit2612` rather than `exact`: an x402 client that assumed the USDC
 * shape would produce a signature this rail cannot use, and it should find that
 * out from the scheme name rather than from a revert.
 */

import type { Address, Hex } from "viem";

export const X402_VERSION = 1;
export const SCHEME = "exact-permit2612";
export const NETWORK = "flare-coston2";

export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

/** What the server tells an unpaid client it will accept. */
export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: typeof NETWORK;
  /** FXRP base units owed. A string because JSON has no integers this size. */
  maxAmountRequired: string;
  /** Human-readable USD price the amount was derived from. */
  priceUsd: string;
  /** The XRP/USD rate used, so the client can check the conversion itself. */
  rate: { feedId: Hex; value: string; decimals: number; timestamp: string };
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  /** The facilitator contract that will execute the payment. */
  facilitator: Address;
  /** Bound into the intent; single use. */
  invoiceId: Hex;
  /** Unix seconds. Both signatures expire at this time. */
  deadline: string;
  maxTimeoutSeconds: number;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

/** What the client puts in the X-PAYMENT header, base64-encoded. */
export interface PaymentPayload {
  x402Version: number;
  scheme: typeof SCHEME;
  network: typeof NETWORK;
  payload: {
    intent: {
      invoiceId: Hex;
      payer: Address;
      payee: Address;
      amount: string;
      deadline: string;
    };
    /** EIP-2612 permit signature over the FXRP domain. */
    permitSignature: { v: number; r: Hex; s: Hex };
    /** PaymentIntent signature over the facilitator's domain. */
    intentSignature: { v: number; r: Hex; s: Hex };
  };
}

/** What the server returns after settling, base64-encoded. */
export interface PaymentResponse {
  success: boolean;
  network: typeof NETWORK;
  transaction?: Hex;
  blockNumber?: string;
  payer?: Address;
  delivered?: string;
  gasUsed?: string;
  gasPaidBy?: Address;
  error?: string;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * Decode a base64 header. Anything malformed is the client's problem, so this
 * throws a message meant to be handed straight back over HTTP rather than
 * logged and swallowed.
 */
export function decodeHeader<T>(header: string): T {
  let json: string;
  try {
    json = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new Error("payment header is not valid base64");
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error("payment header is not valid JSON");
  }
}

/**
 * Check a decoded payload is the shape and scheme we handle before any of it
 * reaches a contract call. A client speaking USDC-flavoured x402 fails here with
 * a sentence explaining why, which is the whole reason the scheme is named.
 */
export function assertPayload(value: unknown): asserts value is PaymentPayload {
  const p = value as PaymentPayload;
  if (!p || typeof p !== "object") throw new Error("payment payload is not an object");
  if (p.x402Version !== X402_VERSION) {
    throw new Error(`unsupported x402Version ${p.x402Version}, expected ${X402_VERSION}`);
  }
  if (p.scheme !== SCHEME) {
    throw new Error(
      `unsupported scheme "${p.scheme}". This rail settles FXRP, which implements ` +
        `EIP-2612 permit rather than EIP-3009, so it uses "${SCHEME}" and requires ` +
        "two signatures: a permit and a PaymentIntent.",
    );
  }
  if (p.network !== NETWORK) {
    throw new Error(`unsupported network "${p.network}", expected "${NETWORK}"`);
  }
  const body = p.payload;
  if (!body?.intent || !body.permitSignature || !body.intentSignature) {
    throw new Error("payment payload is missing intent, permitSignature or intentSignature");
  }
}
