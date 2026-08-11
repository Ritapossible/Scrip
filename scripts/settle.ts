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
  parseAbi,
  keccak256,
  toBytes,
  parseUnits,
  formatUnits,
  getAddress,
  decodeEventLog,
  hashTypedData,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2, FLARE_CONTRACT_REGISTRY, txUrl, addressUrl } from "../src/chain.js";

const registryAbi = parseAbi([
  "function getContractAddressByName(string _name) view returns (address)",
]);

const assetManagerAbi = parseAbi(["function fAsset() view returns (address)"]);

const fxrpAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

const facilitatorAbi = parseAbi([
  "struct PaymentIntent { bytes32 invoiceId; address payer; address payee; uint256 amount; uint256 deadline; }",
  "struct Signature { uint8 v; bytes32 r; bytes32 s; }",
  "function settle(PaymentIntent intent, Signature permitSig, Signature intentSig)",
  "function intentDigest(PaymentIntent intent) view returns (bytes32)",
  "function token() view returns (address)",
  "function settled(bytes32) view returns (bool)",
  "event PaymentSettled(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 requested, uint256 delivered)",
  // Without these a revert decodes to a bare selector and every failure looks
  // the same.
  "error AlreadySettled(bytes32 invoiceId)",
  "error Underdelivered(uint256 requested, uint256 delivered)",
  "error Expired(uint256 deadline, uint256 nowTime)",
  "error IntentNotSignedByPayer(address recovered, address payer)",
  "error MalleableSignature()",
  "error BadSignatureV(uint8 v)",
  "error InsufficientAllowance(uint256 have, uint256 need)",
  "error TransferFailed()",
  "error ZeroPayee()",
]);

const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const intentTypes = {
  PaymentIntent: [
    { name: "invoiceId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/** viem returns a packed 65-byte signature; the contract takes v, r, s. */
function split(sig: Hex): { v: number; r: Hex; s: Hex } {
  return {
    r: `0x${sig.slice(2, 66)}` as Hex,
    s: `0x${sig.slice(66, 130)}` as Hex,
    v: parseInt(sig.slice(130, 132), 16),
  };
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
  const assetManager = await client.readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["AssetManagerFXRP"],
  });
  const fxrp = await client.readContract({
    address: assetManager,
    abi: assetManagerAbi,
    functionName: "fAsset",
  });

  const [decimals, symbol, boundToken] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "decimals" }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "symbol" }),
    client.readContract({ address: facilitator, abi: facilitatorAbi, functionName: "token" }),
  ]);

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
  const domain = await client.readContract({
    address: fxrp,
    abi: fxrpAbi,
    functionName: "eip712Domain",
  });
  const tokenDomain = {
    name: domain[1],
    version: domain[2],
    chainId: Number(domain[3]),
    verifyingContract: domain[4],
  } as const;

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

  const intentDomain = {
    name: "Scrip",
    version: "1",
    chainId: coston2.id,
    verifyingContract: facilitator,
  } as const;

  const localDigest = hashTypedData({
    domain: intentDomain,
    types: intentTypes,
    primaryType: "PaymentIntent",
    message: intent,
  });

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
      domain: intentDomain,
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

/**
 * Every custom error the facilitator can raise, said in a sentence. The nine
 * signatures are in facilitatorAbi so viem can decode a revert; without this
 * they still arrive as a name and a tuple, which is only marginally better than
 * a bare selector when the demo is on a clock.
 */
function explainRevert(name: string, args: readonly unknown[]): string {
  switch (name) {
    case "Expired":
      return `the deadline passed before the transaction was mined (deadline ${args[0]}, block time ${args[1]}). The public Coston2 RPC can be slow - just run it again.`;
    case "AlreadySettled":
      return `invoice ${args[0]} was already settled. Invoice IDs are single-use.`;
    case "IntentNotSignedByPayer":
      return `the intent signature recovered to ${args[0]}, not the payer ${args[1]}. The signer and the contract disagree about the EIP-712 domain or the intent fields.`;
    case "InsufficientAllowance":
      return `the permit did not grant enough allowance (have ${args[0]}, need ${args[1]}). The permit signature was probably rejected by the token - check the payer's nonce.`;
    case "Underdelivered":
      return `the payee received ${args[1]} but the invoice was for ${args[0]}. FXRP is levying a transfer fee, so the invoice cannot be settled at face value.`;
    case "TransferFailed":
      return "FXRP's transferFrom failed or returned false.";
    case "ZeroPayee":
      return "PAYEE_ADDRESS is the zero address.";
    case "MalleableSignature":
      return "a signature had a high-half-order s value. The signer is not normalising to EIP-2.";
    case "BadSignatureV":
      return `signature v was ${args[0]}, expected 27 or 28.`;
    default:
      return `${name}(${args.join(", ")})`;
  }
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
