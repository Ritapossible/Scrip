/**
 * Every ABI the rail uses, in one place.
 *
 * These were duplicated across settle.ts and the fork test while there were only
 * two callers. There are now five, and a facilitator ABI that disagrees with
 * itself between the signer and the verifier is exactly the class of bug this
 * project keeps having to design around, so they live here instead.
 */

import { parseAbi } from "viem";

export const registryAbi = parseAbi([
  "function getContractAddressByName(string _name) view returns (address)",
]);

export const assetManagerAbi = parseAbi(["function fAsset() view returns (address)"]);

export const fxrpAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

export const facilitatorAbi = parseAbi([
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

/**
 * Every custom error the facilitator can raise, said in a sentence. Shared by
 * the CLI and the HTTP service so an agent gets the same diagnosis a human does.
 */
export function explainRevert(name: string, args: readonly unknown[]): string {
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
      return "the payee is the zero address.";
    case "MalleableSignature":
      return "a signature had a high-half-order s value. The signer is not normalising to EIP-2.";
    case "BadSignatureV":
      return `signature v was ${args[0]}, expected 27 or 28.`;
    default:
      return `${name}(${args.join(", ")})`;
  }
}
