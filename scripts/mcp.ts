/**
 * An MCP server, so an assistant can spend through the rail directly.
 *
 *   npm run mcp
 *
 * Everything else in this repo is an agent that was told what to buy. This is
 * the piece that lets an assistant decide: it can ask what a resource costs,
 * look at the price, and pay for it inside a conversation, holding FXRP and no
 * gas token.
 *
 * Five tools. Three of them read - `price`, `quote`, `facilitator` - and cost
 * nothing. `wallet` reads balances. Only `pay` spends, and it is the reason the
 * rest of this file is shaped the way it is.
 *
 * Handing a language model a spending key deserves more than a tool definition,
 * so two limits sit in front of it and neither can be raised by anything the
 * model or the server says:
 *
 *   - a per-call ceiling (SCRIP_MAX_USD_PER_CALL, default $1.00), checked
 *     against the quote's USD price before a signature exists;
 *   - a session budget (SCRIP_MAX_USD_SESSION, default $5.00) that accumulates
 *     across every payment this process makes and cannot be reset without
 *     restarting it.
 *
 * They are enforced here, in the client, because a cap the server sets is not a
 * cap. The payer's own FXRP balance is the third and hardest limit: it holds no
 * gas token, so the worst case for a key that leaks is the FXRP sitting in it.
 *
 * One transport note that will waste an hour otherwise: stdio MCP servers speak
 * JSON-RPC over stdout. Anything else printed there corrupts the stream and the
 * client reports a parse error rather than whatever went wrong. Every diagnostic
 * in this file goes to stderr.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fxrpAbi } from "../src/abi.js";
import { resolveFxrp } from "../src/fxrp.js";
import { resolveFtsoV2, readFeed, usdToTokenAmount, parseUsd, formatUsd, XRP_USD_FEED_ID } from "../src/ftso.js";
import { getQuote, payForResource, publicClient } from "../src/pay.js";
import { txUrl, addressUrl } from "../src/chain.js";
import { NETWORK, SCHEME } from "../src/x402.js";

const client = publicClient(process.env.RPC_URL);

/**
 * The payer is optional on purpose. Without a key this server still prices
 * things, reads quotes and inspects facilitators - all of which are useful and
 * none of which can spend anything. Refusing to start would trade that away for
 * nothing.
 */
const payer = (() => {
  const key = process.env.PAYER_PK;
  if (!key || key === "0x") return undefined;
  try {
    return privateKeyToAccount(key as Hex);
  } catch (err) {
    console.error(`  PAYER_PK is set but unusable: ${(err as Error).message}`);
    return undefined;
  }
})();

const MAX_PER_CALL = process.env.SCRIP_MAX_USD_PER_CALL ?? "1.00";
const MAX_SESSION = process.env.SCRIP_MAX_USD_SESSION ?? "5.00";

const perCallCap = parseUsd(MAX_PER_CALL);
const sessionCap = parseUsd(MAX_SESSION);
/** Micro-dollars spent by this process. Only ever goes up. */
let spent = 0n;
/**
 * Micro-dollars committed to payments that have not finished yet.
 *
 * A tool call is not atomic, and an MCP client may have several in flight. With
 * only `spent` to check against, two concurrent calls both read a budget that
 * still looks unspent, both pass, and the session quietly exceeds its ceiling.
 * Reserving up front and releasing in a `finally` closes that window.
 */
let reserved = 0n;
/**
 * Resources with a payment in flight. Paying for the same thing twice because a
 * client retried a call that had not returned yet is not something the chain can
 * undo - each attempt is a distinct invoice and both would settle.
 */
const inFlight = new Set<string>();

/**
 * Money, written the way money is written. formatUsd trims trailing zeros, which
 * is right for an amount and wrong for a budget line - "$5 of $5.00 remaining"
 * reads like two different numbers.
 */
const money = (micros: bigint): string => {
  const [whole, frac = ""] = formatUsd(micros).split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const server = new McpServer({
  name: "scrip",
  version: "0.1.0",
});

// --- price -------------------------------------------------------------------

server.registerTool(
  "price",
  {
    title: "Price a USD amount in FXRP",
    description:
      "Convert a USD amount into FXRP at Flare's live FTSO XRP/USD feed, the same " +
      "rate every invoice on this rail is priced at. Reads the chain; spends nothing. " +
      "Use it to tell someone what something will cost before paying for it.",
    inputSchema: {
      usd: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, "a plain USD amount like \"0.25\" or \"1\"")
        .default("1.00")
        .describe("USD amount to convert, e.g. \"0.25\""),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ usd }) => {
    try {
      const [fxrp, ftsoV2] = await Promise.all([resolveFxrp(client), resolveFtsoV2(client)]);
      const reading = await readFeed(client, ftsoV2);
      const amount = usdToTokenAmount(parseUsd(usd), reading, fxrp.decimals);

      return ok(
        [
          `$${usd} = ${formatUnits(amount, fxrp.decimals)} ${fxrp.symbol}`,
          ``,
          `  rate        $${reading.price} per XRP`,
          `  feed        XRP/USD (${XRP_USD_FEED_ID})`,
          `  published   block timestamp ${reading.timestamp}`,
          `  asset       ${fxrp.address} (${fxrp.decimals} decimals)`,
          ``,
          `The amount rounds up: the facilitator reverts if the payee receives less`,
          `than the invoice, so a rounding error in the payer's favour would be a`,
          `failed payment rather than a cheap one.`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`could not price $${usd}: ${(err as Error).message}`);
    }
  },
);

// --- wallet ------------------------------------------------------------------

server.registerTool(
  "wallet",
  {
    title: "Show the payer wallet and remaining budget",
    description:
      "Report the payer's address, its FXRP balance, its native C2FLR balance, and " +
      "how much of this session's spending budget is left. The C2FLR balance is " +
      "expected to be zero - that zero is what makes payments on this rail gasless.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    if (!payer) {
      return fail(
        "No payer key. Set PAYER_PK in .env to enable the wallet and payment tools. " +
          "Pricing and quoting work without one.",
      );
    }
    try {
      const fxrp = await resolveFxrp(client);
      const [balance, native] = await Promise.all([
        client.readContract({
          address: fxrp.address,
          abi: fxrpAbi,
          functionName: "balanceOf",
          args: [payer.address],
        }),
        client.getBalance({ address: payer.address }),
      ]);

      const committed = spent + reserved;
      const remaining = sessionCap > committed ? sessionCap - committed : 0n;

      return ok(
        [
          `payer         ${payer.address}`,
          `              ${addressUrl(payer.address)}`,
          ``,
          `  FXRP        ${formatUnits(balance, fxrp.decimals)} ${fxrp.symbol}`,
          `  C2FLR       ${formatUnits(native, 18)}${native === 0n ? "  (gasless: holds no gas token)" : "  (holds gas - payments still work, but this wallet no longer demonstrates gaslessness)"}`,
          ``,
          `  spent       $${money(spent)} this session`,
          `  budget      $${money(remaining)} of $${money(sessionCap)} remaining`,
          `  per call    $${money(perCallCap)} maximum`,
          ``,
          `network       ${NETWORK}`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`could not read the wallet: ${(err as Error).message}`);
    }
  },
);

// --- quote -------------------------------------------------------------------

server.registerTool(
  "quote",
  {
    title: "Ask what a paid resource costs",
    description:
      "Fetch a URL, expect HTTP 402, and report the price without paying it. Also " +
      "runs the checks a payer should run before signing: that the invoice names the " +
      "FXRP the registry resolves to, and that the FXRP amount matches the USD price " +
      "at the rate the server itself published. Spends nothing and signs nothing. " +
      "Call this before `pay` when the price is not already known.",
    inputSchema: {
      url: z.string().url().describe("URL of the paid resource, e.g. https://host/api/haiku"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url }) => {
    try {
      const quote = await getQuote(client, url);
      const overCap = parseUsd(quote.usd) > perCallCap;

      return ok(
        [
          `${url}`,
          `costs $${quote.usd} = ${quote.amountFormatted} ${quote.fxrp.symbol}`,
          ``,
          `  description ${quote.terms.description}`,
          `  pay to      ${quote.terms.payTo}`,
          `  rate        $${quote.rateUsd} per XRP, from the FTSO feed`,
          `  invoice     ${quote.terms.invoiceId}`,
          `  expires     ${quote.deadline} (unix seconds)`,
          `  facilitator ${quote.facilitator}`,
          `  scheme      ${quote.terms.scheme}`,
          ``,
          `checks run before this would be signed:`,
          ...quote.checks.map((c) => `  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`),
          ``,
          overCap
            ? `This costs more than the $${money(perCallCap)} per-call cap, so \`pay\` will refuse it.`
            : `Within the $${money(perCallCap)} per-call cap. $${money(sessionCap > spent ? sessionCap - spent : 0n)} left in this session's budget.`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`could not quote ${url}: ${(err as Error).message}`);
    }
  },
);

// --- pay ---------------------------------------------------------------------

server.registerTool(
  "pay",
  {
    title: "Pay for a resource and return it",
    description:
      "Spends real FXRP. Fetches a paid URL, signs the two messages the payment " +
      "needs, settles it on Flare through the facilitator, and returns the resource " +
      "along with the transaction that paid for it. The payer sends no transaction " +
      "and needs no gas token; a relayer pays the gas. " +
      "Refuses anything above the per-call cap or beyond this session's remaining " +
      "budget. Quote first if the user has not agreed to a price.",
    inputSchema: {
      url: z.string().url().describe("URL of the paid resource"),
      maxUsd: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, "a plain USD amount like \"0.25\"")
        .optional()
        .describe(
          "Refuse to pay more than this, in USD. Lowers the per-call cap for this " +
            "call; it can never raise it.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ url, maxUsd }) => {
    if (!payer) {
      return fail("No payer key. Set PAYER_PK in .env before paying for anything.");
    }

    if (inFlight.has(url)) {
      return fail(
        `a payment for ${url} is already in progress. Wait for it rather than ` +
          `starting a second one - each attempt is its own invoice, and both would settle.`,
      );
    }

    let reservation = 0n;
    try {
      const quote = await getQuote(client, url);
      const price = parseUsd(quote.usd);

      // The caller may tighten the cap but never loosen it.
      const cap = maxUsd !== undefined ? min(parseUsd(maxUsd), perCallCap) : perCallCap;
      if (price > cap) {
        return fail(
          `${url} costs $${quote.usd}, over the $${money(cap)} limit for this call. ` +
            `Not paying. Raise SCRIP_MAX_USD_PER_CALL if this is intended.`,
        );
      }

      // Counted against payments still in flight as well as finished ones, or
      // two concurrent calls both see an unspent budget and both proceed.
      const committed = spent + reserved;
      if (committed + price > sessionCap) {
        return fail(
          `paying $${quote.usd} would take this session to $${money(committed + price)}, ` +
            `over the $${money(sessionCap)} budget. Already spent $${money(spent)}` +
            (reserved > 0n ? `, with $${money(reserved)} in flight` : "") +
            `. Restart the server or raise SCRIP_MAX_USD_SESSION.`,
        );
      }

      reservation = price;
      reserved += reservation;
      inFlight.add(url);

      // The ceiling goes with the payment. A server may answer with a fresh
      // quote at a price of its choosing, and without this the client would sign
      // it - so the effective cap is the tighter of this call's limit and what
      // is left of the session, enforced again before any re-signing.
      const remaining = sessionCap > committed ? sessionCap - committed : 0n;
      const result = await payForResource({
        client,
        payer,
        url,
        quote,
        maxUsd: money(min(cap, remaining)),
      });

      // What was actually paid, which is not the first quote if it was reissued.
      spent += parseUsd(result.quote.usd);

      const receipt = result.receipt;
      const delivered = receipt?.delivered
        ? `${formatUnits(BigInt(receipt.delivered), result.quote.fxrp.decimals)} ${result.quote.fxrp.symbol}`
        : result.quote.amountFormatted;

      const body =
        typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);

      return ok(
        [
          `Paid $${result.quote.usd} (${delivered}) for ${url}`,
          ``,
          `${result.status} - the resource:`,
          body,
          ``,
          `settled`,
          `  tx          ${receipt?.transaction ?? "-"}`,
          `              ${receipt?.transaction ? txUrl(receipt.transaction) : ""}`,
          `  block       ${receipt?.blockNumber ?? "-"}`,
          `  delivered   ${delivered}`,
          `  gas used    ${receipt?.gasUsed ?? "-"}`,
          `  gas paid by ${receipt?.gasPaidBy ?? "-"}`,
          `  payer C2FLR ${formatUnits(result.nativeBefore, 18)} -> ${formatUnits(result.nativeAfter, 18)}`,
          ``,
          result.gasless
            ? `The payer held no gas token before or after. It signed two messages and sent no transaction.`
            : `Note: the payer holds C2FLR, so this payment does not demonstrate gaslessness (it was still settled by the relayer).`,
          ``,
          `  spent       $${money(spent)} of $${money(sessionCap)} this session`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`payment failed for ${url}: ${(err as Error).message}`);
    } finally {
      // Released whether the payment settled, was refused or threw. `spent` has
      // already absorbed anything that actually moved.
      reserved -= reservation;
      inFlight.delete(url);
    }
  },
);

// --- facilitator -------------------------------------------------------------

server.registerTool(
  "facilitator",
  {
    title: "Inspect an x402 facilitator",
    description:
      "Ask a facilitator what payment kinds it supports and whether it is healthy. " +
      "Useful for checking a deployment is reachable before trying to pay through it.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Base URL of the facilitator, e.g. https://scrip-production.up.railway.app"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url }) => {
    try {
      const base = url.replace(/\/+$/, "");
      const [supported, health] = await Promise.all([
        fetch(`${base}/supported`).then((r) => r.json()),
        fetch(`${base}/health`)
          .then((r) => r.json())
          .catch(() => undefined),
      ]);

      const kinds = (supported as { kinds?: { scheme: string; network: string }[] }).kinds ?? [];
      const speaksOurs = kinds.some((k) => k.scheme === SCHEME && k.network === NETWORK);

      return ok(
        [
          `${base}`,
          ``,
          `  healthy     ${health ? "yes" : "no /health response"}`,
          `  kinds       ${kinds.map((k) => `${k.scheme} on ${k.network}`).join(", ") || "none reported"}`,
          `  facilitator ${(supported as { facilitator?: string }).facilitator ?? "-"}`,
          `  relayer     ${(supported as { relayer?: string }).relayer ?? "-"}`,
          ``,
          speaksOurs
            ? `Speaks ${SCHEME} on ${NETWORK}. This client can pay through it.`
            : `Does not report ${SCHEME} on ${NETWORK}. This client cannot pay through it.`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`could not reach ${url}: ${(err as Error).message}`);
    }
  },
);

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function main(): Promise<void> {
  // stderr, not stdout: stdout carries the JSON-RPC stream.
  console.error(`scrip MCP server - ${NETWORK}`);
  console.error(`  payer      ${payer ? payer.address : "none (read-only: price, quote, facilitator)"}`);
  console.error(`  per call   $${money(perCallCap)}`);
  console.error(`  session    $${money(sessionCap)}`);

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(`mcp server failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
