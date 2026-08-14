/**
 * Phase 1 - read-only probe. No gas, no keys required beyond an address.
 *
 * This answers, from the chain itself, the four questions the facilitator
 * design depends on. Reading them beats reasoning about them: FXRP's
 * ERC20Permit is a vendored fork rather than stock OpenZeppelin, so anything
 * inferred from upstream docs is a guess.
 *
 *   1. Where is FXRP?          registry -> AssetManagerFXRP -> fAsset()
 *   2. What are its decimals?  read them; XRP is natively 6, not 18
 *   3. Is signing safe?        rebuild the EIP-712 domain from eip712Domain()
 *                              (IERC5267) and check it against the contract's
 *                              own DOMAIN_SEPARATOR()
 *   4. Where is the payer?     nonce + balances, so settle.ts can be exact
 *
 * Check 3 is the important one. If those two hashes match, signTypedData will
 * produce signatures the token accepts. If they do not, every permit reverts
 * with no useful reason and the day disappears into debugging a signer that
 * was never wrong.
 */

import "dotenv/config";
import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  encodeAbiParameters,
  parseAbiParameters,
  formatUnits,
  getAddress,
} from "viem";
import { coston2, FLARE_CONTRACT_REGISTRY, addressUrl } from "../src/chain.js";

const registryAbi = parseAbi([
  "function getContractAddressByName(string _name) view returns (address)",
]);

const assetManagerAbi = parseAbi(["function fAsset() view returns (address)"]);

const fxrpAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main(): Promise<void> {
  // The public Coston2 RPC is slow on a cold call - well past viem's 10s
  // default. A timeout here reads as "the chain is down" when it is only warming.
  const client = createPublicClient({
    chain: coston2,
    transport: http(undefined, { timeout: 45_000, retryCount: 3 }),
  });

  const payer = process.env.PAYER_ADDRESS
    ? getAddress(process.env.PAYER_ADDRESS)
    : undefined;

  console.log("\nScrip probe - Coston2\n");

  // --- 1. Resolve FXRP without hardcoding it -------------------------------
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

  console.log("addresses");
  line("AssetManagerFXRP", assetManager);
  line("FXRP", fxrp);
  line("explorer", addressUrl(fxrp));

  // --- 2. Token facts, read rather than assumed ---------------------------
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "name" }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "symbol" }),
    client.readContract({ address: fxrp, abi: fxrpAbi, functionName: "decimals" }),
  ]);

  console.log("\ntoken");
  line("name", name);
  line("symbol", symbol);
  line("decimals", String(decimals));
  if (decimals !== 6) {
    console.log(
      `  note: decimals is ${decimals}, not the 6 XRP uses natively - ` +
        "every amount in settle.ts must use this value, not a literal.",
    );
  }

  // --- 3. The gate: does the EIP-712 domain reconstruct? -------------------
  const [domain, onchainSeparator] = await Promise.all([
    client.readContract({
      address: fxrp,
      abi: fxrpAbi,
      functionName: "eip712Domain",
    }),
    client.readContract({
      address: fxrp,
      abi: fxrpAbi,
      functionName: "DOMAIN_SEPARATOR",
    }),
  ]);

  const [, domainName, version, chainId, verifyingContract] = domain;

  const rebuilt = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes(domainName)),
        keccak256(toBytes(version)),
        chainId,
        verifyingContract,
      ],
    ),
  );

  console.log("\neip-712 domain (from IERC5267, not guessed)");
  line("name", domainName);
  line("version", version);
  line("chainId", String(chainId));
  line("verifyingContract", verifyingContract);
  line("onchain separator", onchainSeparator);
  line("rebuilt separator", rebuilt);

  const signable = rebuilt.toLowerCase() === onchainSeparator.toLowerCase();
  console.log(
    signable
      ? "\n  PASS  domain reconstructs - signTypedData signatures will verify"
      : "\n  FAIL  domain mismatch - read the vendored ERC20Permit before signing",
  );

  // --- 4. Payer state, so settle.ts can be exact --------------------------
  if (payer) {
    const [fxrpBalance, nativeBalance, nonce] = await Promise.all([
      client.readContract({
        address: fxrp,
        abi: fxrpAbi,
        functionName: "balanceOf",
        args: [payer],
      }),
      client.getBalance({ address: payer }),
      client.readContract({
        address: fxrp,
        abi: fxrpAbi,
        functionName: "nonces",
        args: [payer],
      }),
    ]);

    console.log("\npayer");
    line("address", payer);
    line("FXRP", `${formatUnits(fxrpBalance, decimals)} ${symbol}`);
    line("C2FLR", formatUnits(nativeBalance, 18));
    line("permit nonce", String(nonce));

    if (fxrpBalance === 0n) {
      console.log("\n  payer holds no FXRP - fund it from the Coston2 faucet.");
    }
    if (nativeBalance !== 0n) {
      console.log(
        "\n  note: payer holds C2FLR. Drain it before recording the demo - " +
          "a zero native balance is what proves the payment was gasless.",
      );
    }
  } else {
    console.log(
      "\n  set PAYER_ADDRESS in .env to also report payer balances and nonce.",
    );
  }

  console.log("");
  if (!signable) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(
    `\nprobe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
