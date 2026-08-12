/**
 * Phase 2 - land a gasless payment on live Coston2.
 *
 * The payer signs twice and sends nothing. The relayer sends one transaction
 * and pays for it. If the payer's C2FLR balance is zero before and zero after,
 * the rail works as advertised - that zero is the entire claim.
 *
 *   npm run settle              pays 0.5 FXRP
 *   npm run settle -- 1.25      pays 1.25 FXRP
 *
 * Needs PAYER_PK, RELAYER_PK, PAYEE_ADDRESS and FACILITATOR_ADDRESS in .env.
 *
 * Every fact this depends on is read from the chain rather than assumed:
 * FXRP's address comes from the registry, its decimals and EIP-712 domain come
 * from the token, and the intent digest is checked against the facilitator's
 * own intentDigest() before anything is signed for real. A digest mismatch
 * otherwise surfaces as IntentNotSignedByPayer, which says nothing useful about
 * why.
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  parseUnits,
  formatUnits,
  getAddress,
  decodeEventLog,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2, txUrl, addressUrl } from "../src/chain.js";
import { fxrpAbi, facilitatorAbi, explainRevert } from "../src/abi.js";
import { resolveFxrp } from "../src/fxrp.js";
import { permitTypes, intentTypes, intentDomain, intentDigest, split } from "../src/eip712.js";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") {
    throw new Error(`${name} is not set in .env - copy .env.example and fill it in.`);
  }
  return value;
}

async function main(): Promise<void> {
  const payer = privateKeyToAccount(required("PAYER_PK") as Hex);
  const relayer = privateKeyToAccount(required("RELAYER_PK") as Hex);
  const payee = getAddress(required("PAYEE_ADDRESS"));
  const facilitator = getAddress(required("FACILITATOR_ADDRESS"));

  // The public Coston2 RPC is slow on a cold call - well past viem's 10s default.
  const transport = http(process.env.RPC_URL, { timeout: 45_000, retryCount: 3 });
  const client = createPublicClient({ chain: coston2, transport });
  const relayerWallet = createWalletClient({ account: relayer, chain: coston2, transport });

  console.log("\nScrip settle - Coston2\n");

  // --- resolve, never hardcode ---------------------------------------------
  const { address: fxrp, decimals, symbol, domain: tokenDomain } = await resolveFxrp(client);

  const boundToken = await client.readContract({
    address: facilitator,
    abi: facilitatorAbi,
    functionName: "token",
  });

  // token is immutable, so a facilitator bound to a stale FXRP can never be
  // fixed - only redeployed. Better to find out here than inside a revert.
  if (getAddress(boundToken) !== getAddress(fxrp)) {
    throw new Error(
      `facilitator is bound to ${boundToken} but the registry resolves FXRP to ${fxrp}. ` +
        "Redeploy the facilitator against the current token.",
    );
  }

  const amount = parseUnits(process.argv[2] ?? "0.5", decimals);

  console.log("addresses");
  line("FXRP", fxrp);
  line("facilitator", facilitator);
  line("payer", payer.address);
  line("payee", payee);
  line("relayer", relayer.address);

  // --- preflight ------------------------------------------------------------
  const [payerFxrp, payerNative, relayerNative, payerNonce] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [payer.address] }),
    client.getBalance({ address: payer.address }),
    client.getBalance({ address: relayer.address }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "nonces", args: [payer.address] }),
  ]);

  console.log("\nbefore");
  line("invoice", `${formatUnits(amount, decimals)} ${symbol}`);
  line("payer FXRP", `${formatUnits(payerFxrp, decimals)} ${symbol}`);
  line("payer C2FLR", `${formatUnits(payerNative, 18)}  <- the claim is this stays 0`);
  line("relayer C2FLR", formatUnits(relayerNative, 18));
  line("payer permit nonce", String(payerNonce));

  if (payerFxrp < amount) {
    throw new Error(
      `payer holds ${formatUnits(payerFxrp, decimals)} ${symbol}, needs ` +
        `${formatUnits(amount, decimals)}. Fund it from the Coston2 faucet.`,
    );
  }
  if (relayerNative === 0n) {
    throw new Error("relayer holds no C2FLR and cannot pay for the transaction.");
  }
  if (payerNative !== 0n) {
    console.log(
      "\n  note: the payer holds C2FLR. The payment still works, but drain it " +
        "before recording the demo - a zero native balance is the proof.",
    );
  }

  // --- sign: offchain, no gas, no transaction -------------------------------
  // One deadline governs both signatures. An hour is generous for a testnet
  // whose public RPC is slow on a cold call; DEADLINE_SECONDS exists so the
  // expiry path can be forced with a negative value rather than waited out.
  const block = await client.getBlock();
  const deadline = block.timestamp + BigInt(process.env.DEADLINE_SECONDS ?? 3600);
  const invoiceId = keccak256(
    toBytes(process.env.INVOICE_ID ?? `scrip-${Date.now()}-${Math.random()}`),
  );

  const intent = {
    invoiceId,
    payer: payer.address,
    payee,
    amount,
    deadline,
  } as const;

  // The facilitator's own digest is the authority. Checking the locally built
  // one against it turns a signing mismatch into a readable failure here rather
  // than an IntentNotSignedByPayer revert that names no cause.
  const [onchainDigest, alreadySettled] = await Promise.all([
    client.readContract({
      address: facilitator,
      abi: facilitatorAbi,
      functionName: "intentDigest",
      args: [intent],
    }),
    client.readContract({
      address: facilitator,
      abi: facilitatorAbi,
      functionName: "settled",
      args: [invoiceId],
    }),
  ]);
  if (alreadySettled) throw new Error(`invoice ${invoiceId} has already been settled.`);

  const localDigest = intentDigest(facilitator, intent);

  console.log("\nsigning");
  line("token domain", `${tokenDomain.name} v${tokenDomain.version}`);
  line("invoice id", invoiceId);
  line("deadline", `${deadline} (+${process.env.DEADLINE_SECONDS ?? 3600}s)`);
  line("onchain digest", onchainDigest);
  line("local digest", localDigest);

  if (localDigest.toLowerCase() !== onchainDigest.toLowerCase()) {
    throw new Error(
      "intent digest mismatch - the signer and the contract disagree on the " +
        "EIP-712 domain. Do not sign; fix the domain first.",
    );
  }
  console.log("  PASS  digests agree\n");

  const permitSig = split(
    await payer.signTypedData({
      domain: tokenDomain,
      types: permitTypes,
      primaryType: "Permit",
      message: {
        owner: payer.address,
        spender: facilitator,
        value: amount,
        nonce: payerNonce,
        deadline,
      },
    }),
  );

  const intentSig = split(
    await payer.signTypedData({
      domain: intentDomain(facilitator),
      types: intentTypes,
      primaryType: "PaymentIntent",
      message: intent,
    }),
  );

  // --- settle: the relayer sends and pays ----------------------------------
  const payeeBefore = await client.readContract({
    address: fxrp,
    abi: fxrpAbi,
    functionName: "balanceOf",
    args: [payee],
  });

  console.log("settling (relayer sends, relayer pays)");
  const hash = await relayerWallet.writeContract({
    address: facilitator,
    abi: facilitatorAbi,
    functionName: "settle",
    args: [intent, permitSig, intentSig],
  });
  line("tx", txUrl(hash));

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);

  const settledEvent = receipt.logs
    .filter((log) => getAddress(log.address) === facilitator)
    .flatMap((log) => {
      try {
        return [decodeEventLog({ abi: facilitatorAbi, data: log.data, topics: log.topics })];
      } catch {
        return [];
      }
    })
    .find((event) => event.eventName === "PaymentSettled");

  // --- after ----------------------------------------------------------------
  const [payerFxrpAfter, payerNativeAfter, payeeAfter] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [payer.address] }),
    client.getBalance({ address: payer.address }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "balanceOf", args: [payee] }),
  ]);

  const delivered = settledEvent?.args.delivered ?? payeeAfter - payeeBefore;

  console.log("\nafter");
  line("block", String(receipt.blockNumber));
  line("gas used", String(receipt.gasUsed));
  line("gas paid by", getAddress(receipt.from));
  line("delivered", `${formatUnits(delivered, decimals)} ${symbol}`);
  line("payer FXRP", `${formatUnits(payerFxrpAfter, decimals)} ${symbol}`);
  line("payee FXRP", `${formatUnits(payeeAfter, decimals)} ${symbol}`);
  line("payer C2FLR", formatUnits(payerNativeAfter, 18));
  line("payee", addressUrl(payee));

  const gasless = payerNative === 0n && payerNativeAfter === 0n;
  console.log(
    gasless
      ? "\n  PASS  the payer held zero C2FLR throughout - the payment was gasless\n"
      : "\n  the payment settled, but the payer held C2FLR so this run does not " +
          "demonstrate gaslessness. Drain the payer and run it again.\n",
  );
}

main().catch((err: unknown) => {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      const { errorName, args = [] } = revert.data;
      console.error(`\nsettle reverted: ${errorName}`);
      console.error(`  ${explainRevert(errorName, args)}\n`);
      process.exit(1);
    }
  }
  console.error(
    `\nsettle failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
