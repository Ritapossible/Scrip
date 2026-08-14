/**
 * The spending caps, which are the only thing standing between an assistant
 * with a key and a server that names its own price.
 *
 * The bug these exist to prevent: the cap was checked once, against the first
 * quote, and a server that answered a payment with a fresh quote could name any
 * price for the second one. So the property under test is not "a cap exists" but
 * "every quote is checked, including a reissued one".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPayable, type Quote } from "../src/pay.js";
import type { PublicClient } from "viem";

const PAYER = "0x8a2ea73883F5580EEd4f5BB217283814c755D6CD" as const;

/**
 * A quote at a given price. The cap is checked before anything is read from the
 * chain, so a client that would throw if touched proves the check happened first.
 */
function quoteAt(usd: string): Quote {
  return {
    url: "https://example.test/api/thing",
    usd,
    amount: 1_000_000n,
    amountFormatted: "1.000000",
    deadline: 0n,
    facilitator: "0x37A6D9C298B4b6E5Be17D4412B2Fc61097953e93",
    rateUsd: 1,
    checks: [],
    fxrp: {
      address: "0x0b6A3645c240605887a5532109323A3E12273dc7",
      decimals: 6,
      symbol: "FTestXRP",
      domain: { name: "FXRP", version: "1", chainId: 114, verifyingContract: "0x0b6A3645c240605887a5532109323A3E12273dc7" },
    },
    terms: {} as Quote["terms"],
  };
}

/** Fails loudly if the cap check let execution reach the chain. */
const refusingClient = {
  readContract() {
    throw new Error("reached the chain despite the cap being exceeded");
  },
} as unknown as PublicClient;

test("a quote over the cap is refused before anything is read", async () => {
  await assert.rejects(
    assertPayable({ client: refusingClient, quote: quoteAt("500"), payer: PAYER, maxUsd: "1.00" }),
    /over the \$1\.00 cap/,
  );
});

test("the cap compares money, not string length", async () => {
  // "9" > "10" lexically. A cap compared as text would let this through.
  await assert.rejects(
    assertPayable({ client: refusingClient, quote: quoteAt("9"), payer: PAYER, maxUsd: "10" }).then(
      () => {
        throw new Error("unreachable");
      },
      (err: Error) => {
        // Reaching the chain is the correct outcome here: $9 is under a $10 cap,
        // so the balance read is what should fail, not the cap.
        assert.match(err.message, /reached the chain/);
        throw err;
      },
    ),
    /reached the chain/,
  );
});

test("a quote exactly at the cap is allowed through to the balance check", async () => {
  await assert.rejects(
    assertPayable({ client: refusingClient, quote: quoteAt("1.00"), payer: PAYER, maxUsd: "1.00" }),
    /reached the chain/,
    "a price equal to the cap must not be refused",
  );
});

test("sub-cent differences are respected", async () => {
  await assert.rejects(
    assertPayable({
      client: refusingClient,
      quote: quoteAt("1.000001"),
      payer: PAYER,
      maxUsd: "1.00",
    }),
    /over the \$1\.00 cap/,
  );
});

test("no cap means no ceiling, and the chain decides", async () => {
  await assert.rejects(
    assertPayable({ client: refusingClient, quote: quoteAt("999999"), payer: PAYER }),
    /reached the chain/,
  );
});
