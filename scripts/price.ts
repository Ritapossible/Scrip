/**
 * Price a USD invoice in FXRP at the live FTSO rate.
 *
 *   npm run price            prices $0.25
 *   npm run price -- 1.50    prices $1.50
 *
 * Read-only: no keys, no gas, no transaction. This is the oracle half of the
 * rail on its own, so a failure here is unambiguous rather than surfacing later
 * as a wrong invoice amount.
 */

import "dotenv/config";
import { createPublicClient, http, formatUnits } from "viem";
import { coston2 } from "../src/chain.js";
import { resolveFxrp } from "../src/fxrp.js";
import {
  XRP_USD_FEED_ID,
  resolveFtsoV2,
  readFeed,
  assertFresh,
  usdToTokenAmount,
  parseUsd,
  formatUsd,
} from "../src/ftso.js";

const line = (label: string, value: string): void =>
  console.log(`  ${label.padEnd(20)} ${value}`);

async function main(): Promise<void> {
  const transport = http(process.env.RPC_URL, { timeout: 45_000, retryCount: 3 });
  const client = createPublicClient({ chain: coston2, transport });

  const usd = parseUsd(process.argv[2] ?? "0.25");

  const [ftsoV2, { address: fxrp, decimals, symbol }, block] = await Promise.all([
    resolveFtsoV2(client),
    resolveFxrp(client),
    client.getBlock(),
  ]);

  const reading = await readFeed(client, ftsoV2);

  console.log("\nScrip price - Coston2\n");
  console.log("resolved");
  line("FtsoV2", ftsoV2);
  line("FXRP", `${fxrp} (${symbol}, ${decimals} decimals)`);

  console.log("\nfeed");
  line("feed id", XRP_USD_FEED_ID);
  line("raw value", String(reading.value));
  line("feed decimals", String(reading.decimals));
  line("XRP/USD", `$${reading.price}`);
  line("published", `${reading.timestamp} (${block.timestamp - reading.timestamp}s ago)`);

  assertFresh(reading, block.timestamp);
  console.log("  PASS  feed is fresh\n");

  const amount = usdToTokenAmount(usd, reading, decimals);

  console.log("invoice");
  line("USD", `$${formatUsd(usd)}`);
  line("FXRP owed", `${formatUnits(amount, decimals)} ${symbol}`);
  line("base units", String(amount));
  console.log(
    "\n  rounded up, so the payee is never short and settle() cannot revert\n" +
      "  with Underdelivered on a rounding error\n",
  );
}

main().catch((err: unknown) => {
  console.error(`\nprice failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
