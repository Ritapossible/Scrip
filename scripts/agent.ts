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
 * It also checks the invoice before paying it. A client that signs whatever a
 * server puts in front of it is not a payment rail, it is a wallet drain, so the
 * quoted amount is recomputed from the quoted rate and the intent digest is
 * checked against the facilitator's own before anything is signed.
 */

import "dotenv/config";
import { createPublicClient, http, formatUnits, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "../src/chain.js";
import { fxrpAbi, facilitatorAbi } from "../src/abi.js";
import { resolveFxrp } from "../src/fxrp.js";
import { permitTypes, intentTypes, intentDomain, intentDigest, split } from "../src/eip712.js";
import { usdToTokenAmount, parseUsd } from "../src/ftso.js";
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
  type PaymentResponse,
} from "../src/x402.js";

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

  const transport = http(process.env.RPC_URL, { timeout: 45_000, retryCount: 3 });
  const client = createPublicClient({ chain: coston2, transport });

  console.log("\nScrip agent\n");
  line("resource", url);
  line("payer", payer.address);

  // --- 1. ask, unpaid --------------------------------------------------------
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
      `server wants ${terms.scheme} on ${terms.network}; this agent speaks ` +
        `${SCHEME} on ${NETWORK}`,
    );
  }

  const amount = BigInt(terms.maxAmountRequired);
  const deadline = BigInt(terms.deadline);
  const facilitator = getAddress(terms.facilitator);

  console.log("\n402 payment required");
  line("price", `$${terms.priceUsd}`);
  line("amount", `${formatUnits(amount, terms.assetDecimals)} ${terms.assetSymbol}`);
  line("XRP/USD", `$${Number(terms.rate.value) / 10 ** terms.rate.decimals}`);
  line("pay to", terms.payTo);
  line("invoice", terms.invoiceId);

  // --- 2. check the invoice before signing it -------------------------------
  const fxrp = await resolveFxrp(client);
  if (getAddress(terms.asset) !== getAddress(fxrp.address)) {
    throw new Error(
      `server quoted asset ${terms.asset}, but the registry resolves FXRP to ` +
        `${fxrp.address}. Refusing to pay in an unknown token.`,
    );
  }

  // Recompute the price from the rate the server showed its working for. This
  // catches a server that quotes an honest rate and then charges more.
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
  console.log("  PASS  quoted amount matches the quoted rate");

  const balance = await client.readContract({
    address: fxrp.address,
    abi: fxrpAbi,
    functionName: "balanceOf",
    args: [payer.address],
  });
  if (balance < amount) {
    throw new Error(
      `payer holds ${formatUnits(balance, fxrp.decimals)} ${fxrp.symbol}, invoice is ` +
        `${formatUnits(amount, fxrp.decimals)}.`,
    );
  }

  const intent = {
    invoiceId: terms.invoiceId,
    payer: payer.address,
    payee: getAddress(terms.payTo),
    amount,
    deadline,
  } as const;

  // The contract's digest is the authority. A mismatch here means the domain is
  // wrong, and signing anyway produces an IntentNotSignedByPayer revert that
  // explains nothing.
  const onchainDigest = await client.readContract({
    address: facilitator,
    abi: facilitatorAbi,
    functionName: "intentDigest",
    args: [intent],
  });
  if (intentDigest(facilitator, intent).toLowerCase() !== onchainDigest.toLowerCase()) {
    throw new Error("intent digest mismatch - do not sign; fix the domain first");
  }
  console.log("  PASS  intent digest agrees with the facilitator");

  // --- 3. sign twice, offchain, no gas --------------------------------------
  const nonce = await client.readContract({
    address: fxrp.address,
    abi: fxrpAbi,
    functionName: "nonces",
    args: [payer.address],
  });

  const permitSignature = split(
    await payer.signTypedData({
      domain: fxrp.domain,
      types: permitTypes,
      primaryType: "Permit",
      message: {
        owner: payer.address,
        spender: facilitator,
        value: amount,
        nonce,
        deadline,
      },
    }),
  );

  const intentSignature = split(
    await payer.signTypedData({
      domain: intentDomain(facilitator),
      types: intentTypes,
      primaryType: "PaymentIntent",
      message: intent,
    }),
  );

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME,
    network: NETWORK,
    payload: {
      intent: {
        invoiceId: intent.invoiceId,
        payer: intent.payer,
        payee: intent.payee,
        amount: amount.toString(),
        deadline: deadline.toString(),
      },
      permitSignature,
      intentSignature,
    },
  };

  console.log("\nsigned two messages, sent no transaction");

  // --- 4. ask the facilitator whether this would work ------------------------
  // Verification settles nothing and costs nothing, so there is no reason not to
  // ask before handing the payment over. A resource server that rejected the
  // payment would look identical to one that was simply down; this separates
  // them. If the facilitator is somewhere else, this is skipped rather than
  // treated as a failure.
  const verifyUrl = new URL("/verify", url).toString();
  try {
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload }),
    });
    if (res.ok) {
      const verdict = (await res.json()) as { valid: boolean; reason?: string };
      if (!verdict.valid) {
        throw new Error(`facilitator rejected the payment before settlement: ${verdict.reason}`);
      }
      console.log("  PASS  facilitator verified the payment without settling it");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("facilitator rejected")) throw err;
    console.log(`  note: no facilitator /verify at ${verifyUrl}, skipping the dry run`);
  }

  // --- 5. ask again, paying --------------------------------------------------
  const nativeBefore = await client.getBalance({ address: payer.address });

  const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: encodeHeader(payload) } });
  const body = await paid.text();

  if (!paid.ok) {
    throw new Error(`payment rejected (${paid.status}): ${body}`);
  }

  const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  const receipt = receiptHeader ? decodeHeader<PaymentResponse>(receiptHeader) : undefined;

  const nativeAfter = await client.getBalance({ address: payer.address });

  console.log(`\n${paid.status} ${paid.statusText}`);
  console.log(`  ${body}\n`);

  if (receipt) {
    console.log("settled");
    line("tx", receipt.transaction ?? "-");
    line("block", receipt.blockNumber ?? "-");
    line("delivered", `${formatUnits(BigInt(receipt.delivered ?? "0"), fxrp.decimals)} ${fxrp.symbol}`);
    line("gas used", receipt.gasUsed ?? "-");
    line("gas paid by", receipt.gasPaidBy ?? "-");
  }

  line("payer C2FLR", `${formatUnits(nativeBefore, 18)} -> ${formatUnits(nativeAfter, 18)}`);

  console.log(
    nativeBefore === 0n && nativeAfter === 0n
      ? "\n  PASS  the agent paid for an API call holding no gas token at all\n"
      : "\n  the call was paid for, but the agent holds C2FLR so this run does not " +
          "demonstrate gaslessness\n",
  );
}

main().catch((err: unknown) => {
  console.error(`\nagent failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
