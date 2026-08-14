/**
 * FTSO pricing. Invoices are denominated in USD and settled in FXRP at Flare's
 * enshrined onchain feed, so this is the piece that makes the oracle
 * load-bearing rather than decorative.
 *
 * Nothing here is hardcoded that can be read. FtsoV2 is resolved through the
 * contract registry the same way the asset manager is, and the feed's own
 * decimals come back with every reading rather than being assumed - the FXRP
 * probe already caught one wrong-decimals assumption in this project and the
 * same mistake in a price feed would be a factor-of-ten invoice.
 */

import {
  parseAbi,
  stringToHex,
  padHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { FLARE_CONTRACT_REGISTRY } from "./chain.js";

const registryAbi = parseAbi([
  "function getContractAddressByName(string _name) view returns (address)",
]);

/**
 * FtsoV2 declares its getters `payable` so that a future feed can charge for a
 * reading. The public feeds are free, and declaring them `view` in our own copy
 * of the ABI is what lets us reach them with eth_call instead of paying gas to
 * read a price. If a feed ever does start charging, this call reverts rather
 * than silently returning something stale - which is the failure we want.
 */
const ftsoAbi = parseAbi([
  "function getFeedById(bytes21 _feedId) view returns (uint256 _value, int8 _decimals, uint64 _timestamp)",
]);

/** Feed categories, per Flare's feed id encoding. 1 is crypto. */
export const FEED_CATEGORY_CRYPTO = 1;

/**
 * A feed id is 21 bytes: one category byte followed by the feed name in UTF-8,
 * right-padded with zeros. "XRP/USD" is 7 bytes, so 13 bytes of padding follow.
 */
export function feedId(name: string, category: number = FEED_CATEGORY_CRYPTO): Hex {
  const categoryByte = category.toString(16).padStart(2, "0");
  const nameHex = padHex(stringToHex(name), { size: 20, dir: "right" }).slice(2);
  return `0x${categoryByte}${nameHex}` as Hex;
}

export const XRP_USD_FEED_ID = feedId("XRP/USD");

export interface FeedReading {
  /** Raw integer value as published by the feed. */
  value: bigint;
  /** Decimal places the feed's value carries. Can be negative. */
  decimals: number;
  /** Block timestamp of the reading. */
  timestamp: bigint;
  /** Human-readable price, for display only - never used for arithmetic. */
  price: number;
}

export async function resolveFtsoV2(client: PublicClient): Promise<Address> {
  return client.readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["FtsoV2"],
  });
}

export async function readFeed(
  client: PublicClient,
  ftsoV2: Address,
  id: Hex = XRP_USD_FEED_ID,
): Promise<FeedReading> {
  const [value, decimals, timestamp] = await client.readContract({
    address: ftsoV2,
    abi: ftsoAbi,
    functionName: "getFeedById",
    args: [id],
  });

  return {
    value,
    decimals,
    timestamp,
    price: Number(value) / 10 ** decimals,
  };
}

/**
 * Reject a price old enough that it should not be used to bill someone. FTSO
 * feeds update every few seconds, so anything minutes old means the feed has
 * stalled rather than that the price is calm.
 */
export function assertFresh(
  reading: FeedReading,
  nowSeconds: bigint,
  maxAgeSeconds = 300n,
): void {
  const age = nowSeconds - reading.timestamp;
  if (age > maxAgeSeconds) {
    throw new Error(
      `FTSO feed is ${age}s old (max ${maxAgeSeconds}s). Refusing to price an ` +
        "invoice against a stalled feed.",
    );
  }
}

/** Integer division that rounds up. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Convert a USD invoice into FXRP base units at the feed's rate.
 *
 * USD is carried as micro-dollars (1e6) rather than a float so that a price
 * never passes through binary floating point on its way to becoming an amount
 * of money. The result rounds *up*: the facilitator reverts with
 * `Underdelivered` if the payee receives less than the invoice, so a rounding
 * error in the payer's favour would be a failed payment rather than a cheap
 * one.
 *
 * A feed may report negative decimals for very large values, which shifts the
 * multiplier to the other side of the fraction. Handling that here rather than
 * assuming non-negative keeps this correct for any feed, not just XRP/USD.
 */
export function usdToTokenAmount(
  usdMicros: bigint,
  reading: FeedReading,
  tokenDecimals: number,
): bigint {
  if (reading.value <= 0n) {
    throw new Error("FTSO feed returned a non-positive price; refusing to price an invoice.");
  }

  // amount = usd * 10^tokenDecimals / price, where price = value / 10^feedDecimals
  //        = usdMicros * 10^feedDecimals * 10^tokenDecimals / (1e6 * value)
  const tokenScale = 10n ** BigInt(tokenDecimals);
  const feedScale = 10n ** BigInt(Math.abs(reading.decimals));

  const numerator =
    reading.decimals >= 0
      ? usdMicros * tokenScale * feedScale
      : usdMicros * tokenScale;
  const denominator =
    reading.decimals >= 0
      ? 1_000_000n * reading.value
      : 1_000_000n * reading.value * feedScale;

  return ceilDiv(numerator, denominator);
}

/** Parse a decimal USD string ("0.25", "1", "12.5") into micro-dollars. */
export function parseUsd(input: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new Error(`"${input}" is not a valid USD amount.`);
  }
  // The regex above guarantees both halves exist, but this is the function that
  // turns text into an amount of money - it should not depend on a reader
  // tracing a regex to see that an index is safe.
  const [whole = "0", frac = ""] = input.split(".");
  if (frac.length > 6) {
    throw new Error("USD amounts finer than a millionth of a dollar are not supported.");
  }
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

/** Format micro-dollars back to a plain string, for display. */
export function formatUsd(usdMicros: bigint): string {
  const whole = usdMicros / 1_000_000n;
  const frac = (usdMicros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
