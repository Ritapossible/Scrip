/**
 * The arithmetic that turns a price into an amount of money.
 *
 * These are the functions where a wrong answer is a wrong invoice rather than a
 * failed request, and until now the only thing exercising them was a demo that
 * had to reach live Coston2 to run at all. They are pure, so they can be checked
 * in milliseconds with nothing but a process.
 *
 *   npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUsd,
  formatUsd,
  usdToTokenAmount,
  assertFresh,
  feedId,
  XRP_USD_FEED_ID,
  type FeedReading,
} from "../src/ftso.js";

const reading = (value: bigint, decimals = 6): FeedReading => ({
  value,
  decimals,
  timestamp: 0n,
  price: Number(value) / 10 ** decimals,
});

// --- parseUsd ---------------------------------------------------------------

test("parseUsd converts dollars to micro-dollars", () => {
  assert.equal(parseUsd("1"), 1_000_000n);
  assert.equal(parseUsd("0.25"), 250_000n);
  assert.equal(parseUsd("12.5"), 12_500_000n);
  assert.equal(parseUsd("0"), 0n);
  assert.equal(parseUsd("0.000001"), 1n);
});

test("parseUsd pads a short fraction rather than misreading it", () => {
  // "0.1" is ten cents, not one millionth of a dollar.
  assert.equal(parseUsd("0.1"), 100_000n);
  assert.equal(parseUsd("0.10"), 100_000n);
});

test("parseUsd rejects anything that is not a plain decimal", () => {
  for (const bad of ["", "-1", "1.2.3", "1e6", "$1", "abc", " 1", "1 ", "1,000", "Infinity"]) {
    assert.throws(() => parseUsd(bad), /not a valid USD amount/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("parseUsd refuses precision it cannot represent", () => {
  assert.throws(() => parseUsd("0.0000001"), /millionth/);
});

// --- formatUsd --------------------------------------------------------------

test("formatUsd round-trips parseUsd", () => {
  for (const input of ["0", "1", "0.25", "12.5", "0.000001", "1000000"]) {
    assert.equal(formatUsd(parseUsd(input)), String(Number(input)));
  }
});

// --- usdToTokenAmount -------------------------------------------------------

test("usdToTokenAmount converts at the feed rate", () => {
  // $1.00 at exactly $1/XRP, into a 6-decimal token, is 1.000000.
  assert.equal(usdToTokenAmount(parseUsd("1"), reading(1_000_000n), 6), 1_000_000n);
  // $0.25 at $0.50/XRP is half an XRP.
  assert.equal(usdToTokenAmount(parseUsd("0.25"), reading(500_000n), 6), 500_000n);
});

test("usdToTokenAmount rounds up, never down", () => {
  // The facilitator reverts if the payee receives less than the invoice, so a
  // rounding error in the payer's favour is a failed payment. Anything with a
  // remainder must land on the next unit up.
  const amount = usdToTokenAmount(parseUsd("1"), reading(3_000_000n), 6);
  assert.equal(amount, 333_334n); // 0.333333... rounds up
  assert.ok(amount * 3_000_000n >= parseUsd("1") * 1_000_000n, "must cover the invoice");
});

test("usdToTokenAmount honours the token's decimals", () => {
  // FXRP is 6, not the 18 the minting guide suggests. Getting this wrong is a
  // factor of 10^12.
  assert.equal(usdToTokenAmount(parseUsd("1"), reading(1_000_000n), 6), 10n ** 6n);
  assert.equal(usdToTokenAmount(parseUsd("1"), reading(1_000_000n), 18), 10n ** 18n);
});

test("usdToTokenAmount handles a feed reporting negative decimals", () => {
  // A feed may scale the other way for very large values; the multiplier then
  // belongs on the other side of the fraction. value=1 at decimals=-2 is a
  // price of 1 / 10^-2 = $100, so $100 buys exactly one whole token - which in
  // base units, at 6 decimals, is 1_000_000 rather than 1.
  const negative = usdToTokenAmount(parseUsd("100"), { ...reading(1n), decimals: -2 }, 6);
  assert.equal(negative, 1_000_000n);

  // And half that price buys twice as much, which is the direction that would
  // break if the multiplier were on the wrong side.
  const cheaper = usdToTokenAmount(parseUsd("100"), { ...reading(1n), decimals: -1 }, 6);
  assert.equal(cheaper, 10_000_000n);
});

test("usdToTokenAmount refuses a non-positive price", () => {
  assert.throws(() => usdToTokenAmount(parseUsd("1"), reading(0n), 6), /non-positive/);
  assert.throws(() => usdToTokenAmount(parseUsd("1"), reading(-5n), 6), /non-positive/);
});

test("usdToTokenAmount returns nothing for a zero invoice", () => {
  assert.equal(usdToTokenAmount(0n, reading(1_000_000n), 6), 0n);
});

// --- assertFresh ------------------------------------------------------------

test("assertFresh rejects a stalled feed", () => {
  const stale: FeedReading = { ...reading(1_000_000n), timestamp: 1_000n };
  assert.doesNotThrow(() => assertFresh(stale, 1_100n));
  assert.throws(() => assertFresh(stale, 1_000n + 301n), /refusing to price/i);
});

// --- feed ids ---------------------------------------------------------------

test("feedId encodes 21 bytes: one category byte and a padded name", () => {
  assert.equal(XRP_USD_FEED_ID.length, 2 + 42);
  assert.ok(XRP_USD_FEED_ID.startsWith("0x01"), "crypto category");
  assert.equal(feedId("XRP/USD"), XRP_USD_FEED_ID);
  assert.notEqual(feedId("BTC/USD"), XRP_USD_FEED_ID);
});
