/**
 * Paying a 402, as a library rather than as a script.
 *
 * `scripts/agent.ts` narrates this flow for a human watching a terminal; the MCP
 * server returns it as structured data to an assistant. Both need the same
 * checks in the same order, and a payment path that exists twice is a payment
 * path where only one copy gets fixed. So it lives here once, and the callers
 * differ only in what they do with the events it emits.
 *
 * The checks are the point. A client that signs whatever a server puts in front
 * of it is not a payment rail, it is a wallet drain. Before anything is signed
 * this module:
 *
 *   - resolves FXRP through the registry and refuses a quote naming any other
 *     asset, so a server cannot invoice in a token it minted itself;
 *   - recomputes the FXRP amount from the rate the server showed its working
 *     for, and refuses if they disagree - which catches a server quoting an
 *     honest rate and then charging more than it implies;
 *   - rebuilds the intent digest locally and checks it against the facilitator
 *     contract's own, so a domain mismatch is a sentence rather than an
 *     IntentNotSignedByPayer revert that names no cause.
 *
 * None of them cost gas, and each one is a way the payment could be wrong in the
 * payer's disfavour.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  getAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { coston2 } from "./chain.js";
import { fxrpAbi, facilitatorAbi } from "./abi.js";
import { resolveFxrp, type FxrpInfo } from "./fxrp.js";
import { permitTypes, intentTypes, intentDomain, intentDigest, split } from "./eip712.js";
import { usdToTokenAmount, parseUsd } from "./ftso.js";
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
  type PaymentResponse,
} from "./x402.js";

/** A public client with the timeouts the public Coston2 RPC actually needs. */
export function publicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: coston2,
    transport: http(rpcUrl, { timeout: 45_000, retryCount: 3 }),
  });
}

/** A 402 that has been read and checked, but not yet paid. */
export interface Quote {
  url: string;
  terms: PaymentRequirements;
  fxrp: FxrpInfo;
  /** Base units owed. */
  amount: bigint;
  /** Human-readable, e.g. "0.244356". */
  amountFormatted: string;
  /** USD price as a plain string, e.g. "0.25". */
  usd: string;
  deadline: bigint;
  facilitator: Address;
  /** XRP/USD at the moment of quoting, for display only. */
  rateUsd: number;
  /** Every check this module ran before calling the quote payable. */
  checks: Check[];
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/** Progress, for callers that show their work while it happens. */
export type PayEvent =
  | { type: "quoted"; quote: Quote }
  | { type: "check"; check: Check }
  | { type: "signed" }
  | { type: "verified"; skipped: boolean; detail?: string }
  | { type: "settled"; receipt?: PaymentResponse };

export interface PaidResult {
  status: number;
  statusText: string;
  /** The resource itself, parsed if it was JSON. */
  body: unknown;
  receipt?: PaymentResponse;
  quote: Quote;
  /** The payer's native balance before and after. Both zero is the whole point. */
  nativeBefore: bigint;
  nativeAfter: bigint;
  /** True when the payer held no gas token at any point in the payment. */
  gasless: boolean;
}

/**
 * Ask what a resource costs, and check the answer.
 *
 * Throws if the endpoint is not actually paid, speaks a different scheme, quotes
 * an asset that is not the registry's FXRP, or quotes an amount its own stated
 * rate does not support. Nothing here signs anything or spends anything.
 */
export async function getQuote(client: PublicClient, url: string): Promise<Quote> {
  const unpaid = await fetch(url);
  if (unpaid.status !== 402) {
    throw new Error(
      `expected 402 from ${url}, got ${unpaid.status}. Is the endpoint actually paid?`,
    );
  }

  const challenge = (await unpaid.json()) as PaymentRequiredBody;
  const terms = challenge.accepts?.[0];
  if (!terms) throw new Error("402 carried no payment requirements");
  if (terms.scheme !== SCHEME || terms.network !== NETWORK) {
    throw new Error(
      `server wants ${terms.scheme} on ${terms.network}; this client speaks ` +
        `${SCHEME} on ${NETWORK}`,
    );
  }

  const amount = BigInt(terms.maxAmountRequired);
  const deadline = BigInt(terms.deadline);
  const facilitator = getAddress(terms.facilitator);
  const checks: Check[] = [];

  const fxrp = await resolveFxrp(client);
  if (getAddress(terms.asset) !== getAddress(fxrp.address)) {
    throw new Error(
      `server quoted asset ${terms.asset}, but the registry resolves FXRP to ` +
        `${fxrp.address}. Refusing to pay in an unknown token.`,
    );
  }
  checks.push({
    name: "asset is the registry's FXRP",
    passed: true,
    detail: fxrp.address,
  });

  // Recompute the price from the rate the server published. This catches a
  // server that quotes an honest rate and then charges more than it implies.
  const expected = usdToTokenAmount(
    parseUsd(terms.priceUsd),
    {
      value: BigInt(terms.rate.value),
      decimals: terms.rate.decimals,
      timestamp: BigInt(terms.rate.timestamp),
      price: Number(terms.rate.value) / 10 ** terms.rate.decimals,
    },
    fxrp.decimals,
  );
  if (amount !== expected) {
    throw new Error(
      `quoted ${amount} base units but $${terms.priceUsd} at the quoted rate is ` +
        `${expected}. Refusing to overpay.`,
    );
  }
  checks.push({
    name: "quoted amount matches the quoted rate",
    passed: true,
    detail: `${formatUnits(amount, fxrp.decimals)} ${fxrp.symbol} for $${terms.priceUsd}`,
  });

  return {
    url,
    terms,
    fxrp,
    amount,
    amountFormatted: formatUnits(amount, fxrp.decimals),
    usd: terms.priceUsd,
    deadline,
    facilitator,
    rateUsd: Number(terms.rate.value) / 10 ** terms.rate.decimals,
    checks,
  };
}

/**
 * Sign the two messages a payment needs. No transaction is sent and no gas is
 * spent: this is the step that makes the whole rail gasless from the payer's
 * side.
 */
export async function signPayment(
  client: PublicClient,
  payer: Account,
  quote: Quote,
): Promise<PaymentPayload> {
  const intent = {
    invoiceId: quote.terms.invoiceId,
    payer: payer.address,
    payee: getAddress(quote.terms.payTo),
    amount: quote.amount,
    deadline: quote.deadline,
  } as const;

  // The contract's digest is the authority on what should be signed. A mismatch
  // means the domain is wrong, and signing anyway produces a revert that
  // explains nothing.
  const onchainDigest = await client.readContract({
    address: quote.facilitator,
    abi: facilitatorAbi,
    functionName: "intentDigest",
    args: [intent],
  });
  if (intentDigest(quote.facilitator, intent).toLowerCase() !== onchainDigest.toLowerCase()) {
    throw new Error("intent digest mismatch - do not sign; fix the domain first");
  }
  quote.checks.push({
    name: "intent digest agrees with the facilitator",
    passed: true,
    detail: onchainDigest,
  });

  const nonce = await client.readContract({
    address: quote.fxrp.address,
    abi: fxrpAbi,
    functionName: "nonces",
    args: [payer.address],
  });

  if (!payer.signTypedData) {
    throw new Error("payer account cannot sign typed data");
  }

  const permitSignature = split(
    await payer.signTypedData({
      domain: quote.fxrp.domain,
      types: permitTypes,
      primaryType: "Permit",
      message: {
        owner: payer.address,
        spender: quote.facilitator,
        value: quote.amount,
        nonce,
        deadline: quote.deadline,
      },
    }),
  );

  const intentSignature = split(
    await payer.signTypedData({
      domain: intentDomain(quote.facilitator),
      types: intentTypes,
      primaryType: "PaymentIntent",
      message: intent,
    }),
  );

  return {
    x402Version: X402_VERSION,
    scheme: SCHEME,
    network: NETWORK,
    payload: {
      intent: {
        invoiceId: intent.invoiceId,
        payer: intent.payer,
        payee: intent.payee,
        amount: quote.amount.toString(),
        deadline: quote.deadline.toString(),
      },
      permitSignature,
      intentSignature,
    },
  };
}

/**
 * Ask the facilitator whether this payment would work, before handing it over.
 *
 * Verification settles nothing and costs nothing, so there is no reason to skip
 * it: a resource server that rejects a payment looks identical to one that is
 * simply down, and this separates them. A facilitator that is somewhere else
 * entirely is not a failure - the payment is simply handed over unverified.
 */
async function dryRun(
  url: string,
  payload: PaymentPayload,
): Promise<{ skipped: boolean; detail?: string }> {
  const verifyUrl = new URL("/verify", url).toString();
  try {
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload }),
    });
    if (!res.ok) return { skipped: true, detail: `no /verify at ${verifyUrl}` };

    const verdict = (await res.json()) as { valid: boolean; reason?: string };
    if (!verdict.valid) {
      throw new Error(`facilitator rejected the payment before settlement: ${verdict.reason}`);
    }
    return { skipped: false };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("facilitator rejected")) throw err;
    return { skipped: true, detail: `no /verify at ${verifyUrl}` };
  }
}

/**
 * The whole flow: quote it, check it, sign it, pay it, read the receipt.
 *
 * `onEvent` is how a caller shows its working while this runs. It is optional
 * and never affects the outcome.
 */
export async function payForResource(opts: {
  client: PublicClient;
  payer: Account;
  url: string;
  /** A quote already fetched by the caller, so a price can be shown before paying. */
  quote?: Quote;
  /** Refuse to pay more than this, in USD. */
  maxUsd?: string;
  onEvent?: (event: PayEvent) => void;
}): Promise<PaidResult> {
  const { client, payer, url, onEvent = () => {} } = opts;

  const quote = opts.quote ?? (await getQuote(client, url));
  onEvent({ type: "quoted", quote });

  // signPayment appends its own check to this list, so remember where the
  // pre-signing ones ended rather than assuming how many either step adds.
  const beforeSigning = quote.checks.length;
  for (const check of quote.checks) onEvent({ type: "check", check });

  // A cap the payer sets is the only limit that binds a server it does not
  // control, so it is checked against the quote's own USD price rather than
  // against the FXRP amount, which moves with the feed.
  if (opts.maxUsd !== undefined) {
    const cap = parseUsd(opts.maxUsd);
    if (parseUsd(quote.usd) > cap) {
      throw new Error(
        `resource costs $${quote.usd}, which is over the $${opts.maxUsd} cap. Not paying.`,
      );
    }
  }

  const balance = await client.readContract({
    address: quote.fxrp.address,
    abi: fxrpAbi,
    functionName: "balanceOf",
    args: [payer.address],
  });
  if (balance < quote.amount) {
    throw new Error(
      `payer holds ${formatUnits(balance, quote.fxrp.decimals)} ${quote.fxrp.symbol}, ` +
        `invoice is ${quote.amountFormatted}.`,
    );
  }

  const payload = await signPayment(client, payer, quote);
  for (const check of quote.checks.slice(beforeSigning)) onEvent({ type: "check", check });
  onEvent({ type: "signed" });

  const verified = await dryRun(url, payload);
  onEvent({ type: "verified", ...verified });

  const nativeBefore = await client.getBalance({ address: payer.address });

  const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: encodeHeader(payload) } });
  const text = await paid.text();
  if (!paid.ok) {
    throw new Error(`payment rejected (${paid.status}): ${text}`);
  }

  const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  const receipt = receiptHeader ? decodeHeader<PaymentResponse>(receiptHeader) : undefined;
  onEvent({ type: "settled", receipt });

  const nativeAfter = await client.getBalance({ address: payer.address });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: paid.status,
    statusText: paid.statusText,
    body,
    receipt,
    quote,
    nativeBefore,
    nativeAfter,
    gasless: nativeBefore === 0n && nativeAfter === 0n,
  };
}
