/**
 * An agent that hits a paid endpoint, gets a 402, pays it, and gets the
 * resource. This is the whole product in one file, seen from the client side.
 *
 *   npm run agent                        pays for /api/haiku
 *   npm run agent -- http://host/thing   pays for something else
 *
 * The agent holds FXRP and no gas token. It sends no transaction: it signs two
 * messages and puts them in a header. Everything on chain is done by the
 * relayer, which is why the payer's C2FLR balance is still zero at the end.
 *
 * The payment itself lives in src/pay.ts, which the MCP server also uses - a
 * payment path that exists twice is one where only one copy gets fixed. What
 * remains here is the narration: this script exists to be watched.
 */

import "dotenv/config";
import { formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { payForResource, publicClient } from "../src/pay.js";

const line = (label: string, value: string): void =>
  console.log(`  ${label.padEnd(18)} ${value}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") {
    throw new Error(`${name} is not set in .env - run npm run setup first.`);
  }
  return value;
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 8402}/api/haiku`;
  const payer = privateKeyToAccount(required("PAYER_PK") as Hex);
  const client = publicClient(process.env.RPC_URL);

  console.log("\nScrip agent\n");
  line("resource", url);
  line("payer", payer.address);

  const result = await payForResource({
    client,
    payer,
    url,
    onEvent: (event) => {
      switch (event.type) {
        case "quoted": {
          const q = event.quote;
          console.log("\n402 payment required");
          line("price", `$${q.usd}`);
          line("amount", `${q.amountFormatted} ${q.fxrp.symbol}`);
          line("XRP/USD", `$${q.rateUsd}`);
          line("pay to", q.terms.payTo);
          line("invoice", q.terms.invoiceId);
          break;
        }
        case "reissued":
          console.log(
            `\n  the quote was spent before it settled - signing a fresh one` +
              `\n  invoice            ${event.quote.terms.invoiceId}`,
          );
          break;
        case "check":
          console.log(`  ${event.check.passed ? "PASS" : "FAIL"}  ${event.check.name}`);
          break;
        case "signed":
          console.log("\nsigned two messages, sent no transaction");
          break;
        case "verified":
          console.log(
            event.skipped
              ? `  note: ${event.detail}, skipping the dry run`
              : "  PASS  facilitator verified the payment without settling it",
          );
          break;
        case "settled":
          break;
      }
    },
  });

  const { quote, receipt } = result;
  const body =
    typeof result.body === "string" ? result.body : JSON.stringify(result.body);

  console.log(`\n${result.status} ${result.statusText}`.trimEnd());
  console.log(`  ${body}\n`);

  if (receipt) {
    console.log("settled");
    line("tx", receipt.transaction ?? "-");
    line("block", receipt.blockNumber ?? "-");
    line(
      "delivered",
      `${formatUnits(BigInt(receipt.delivered ?? "0"), quote.fxrp.decimals)} ${quote.fxrp.symbol}`,
    );
    line("gas used", receipt.gasUsed ?? "-");
    line("gas paid by", receipt.gasPaidBy ?? "-");
  }

  line(
    "payer C2FLR",
    `${formatUnits(result.nativeBefore, 18)} -> ${formatUnits(result.nativeAfter, 18)}`,
  );

  console.log(
    result.gasless
      ? "\n  PASS  the agent paid for an API call holding no gas token at all\n"
      : "\n  the call was paid for, but the agent holds C2FLR so this run does not " +
          "demonstrate gaslessness\n",
  );
}

main().catch((err: unknown) => {
  console.error(`\nagent failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
