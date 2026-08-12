/**
 * Move FXRP from the relayer to the payer, so the payer can pay invoices while
 * holding no gas token at all.
 *
 *   npm run fund           sends 2 FXRP
 *   npm run fund -- 5      sends 5 FXRP
 *
 * The relayer signs and pays the fee. The payer's native balance is checked
 * before and after and must be exactly zero - if it is ever nonzero the gasless
 * claim cannot be demonstrated, so this refuses rather than letting settle.ts
 * fail later with a less obvious message.
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2, txUrl } from "../src/chain.js";
import { fxrpAbi } from "../src/abi.js";
import { resolveFxrp } from "../src/fxrp.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") {
    throw new Error(`${name} is not set in .env - run scripts/setup-wallets.mjs first.`);
  }
  return value;
}

const line = (label: string, value: string): void =>
  console.log(`  ${label.padEnd(16)} ${value}`);

async function main(): Promise<void> {
  const payer = privateKeyToAccount(required("PAYER_PK") as Hex);
  const relayer = privateKeyToAccount(required("RELAYER_PK") as Hex);

  const transport = http(process.env.RPC_URL, { timeout: 45_000, retryCount: 3 });
  const client = createPublicClient({ chain: coston2, transport });
  const wallet = createWalletClient({ account: relayer, chain: coston2, transport });

  const { address: fxrp, decimals, symbol } = await resolveFxrp(client);

  const amount = parseUnits(process.argv[2] ?? "2", decimals);

  const [relayerFxrp, relayerNative, payerFxrp, payerNative] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [relayer.address] }),
    client.getBalance({ address: relayer.address }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [payer.address] }),
    client.getBalance({ address: payer.address }),
  ]);

  console.log("\nFund payer - Coston2\n");
  line("token", `${fxrp} (${symbol})`);
  line("relayer", relayer.address);
  line("payer", payer.address);
  console.log("\nbefore");
  line("sending", `${formatUnits(amount, decimals)} ${symbol}`);
  line("relayer FXRP", `${formatUnits(relayerFxrp, decimals)} ${symbol}`);
  line("relayer C2FLR", formatUnits(relayerNative, 18));
  line("payer FXRP", `${formatUnits(payerFxrp, decimals)} ${symbol}`);
  line("payer C2FLR", `${formatUnits(payerNative, 18)}  <- must stay 0`);

  if (relayerFxrp < amount) {
    throw new Error(
      `relayer holds ${formatUnits(relayerFxrp, decimals)} ${symbol}, cannot send ` +
        `${formatUnits(amount, decimals)}.`,
    );
  }
  if (relayerNative === 0n) {
    throw new Error("relayer holds no C2FLR and cannot pay for the transfer.");
  }
  // The entire reason the payer is a separate wallet is that this is zero. If it
  // is not, no amount of FXRP makes the wallet usable for the demo.
  if (payerNative !== 0n) {
    throw new Error(
      `payer holds ${formatUnits(payerNative, 18)} C2FLR but must hold exactly zero - ` +
        "settle.ts tests that equality. Generate a fresh payer with " +
        "scripts/setup-wallets.mjs rather than draining this one; a drain " +
        "transaction burns gas and leaves dust behind.",
    );
  }

  console.log("\nsending (relayer signs and pays)");
  const hash = await wallet.writeContract({
    address: fxrp,
    abi: fxrpAbi,
    functionName: "transfer",
    args: [getAddress(payer.address), amount],
  });
  line("tx", txUrl(hash));

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transfer reverted: ${hash}`);

  const [payerFxrpAfter, payerNativeAfter] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [payer.address] }),
    client.getBalance({ address: payer.address }),
  ]);

  console.log("\nafter");
  line("gas used", String(receipt.gasUsed));
  line("gas paid by", getAddress(receipt.from));
  line("payer FXRP", `${formatUnits(payerFxrpAfter, decimals)} ${symbol}`);
  line("payer C2FLR", formatUnits(payerNativeAfter, 18));

  console.log(
    payerNativeAfter === 0n
      ? "\n  PASS  payer holds FXRP and zero C2FLR - ready to settle gaslessly\n"
      : "\n  the payer somehow received C2FLR. Generate a fresh payer.\n",
  );
}

main().catch((err: unknown) => {
  console.error(`\nfund-payer failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
