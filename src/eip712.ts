/**
 * The two signatures a payment needs, and the domains they live in.
 *
 * A payment carries an EIP-2612 permit (which authorises an allowance but says
 * nothing about where the money goes) and a PaymentIntent over the facilitator's
 * own domain (which names the invoice, the payee and the amount). Neither is
 * sufficient alone: a permit on its own would let anyone who observed it call
 * settle() naming themselves as payee.
 *
 * The signer and the verifier must agree exactly, so both read these from here.
 */

import { hashTypedData, type Address, type Hex } from "viem";
import { coston2 } from "./chain.js";

export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const intentTypes = {
  PaymentIntent: [
    { name: "invoiceId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PaymentIntent {
  invoiceId: Hex;
  payer: Address;
  payee: Address;
  amount: bigint;
  deadline: bigint;
}

export interface SplitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/** The facilitator's EIP-712 domain. Its name and version are fixed in the contract. */
export function intentDomain(facilitator: Address) {
  return {
    name: "Scrip",
    version: "1",
    chainId: coston2.id,
    verifyingContract: facilitator,
  } as const;
}

/**
 * Rebuild the intent digest locally. Checking this against the facilitator's own
 * intentDigest() before signing turns a domain mismatch into a readable error
 * rather than an IntentNotSignedByPayer revert that names no cause.
 */
export function intentDigest(facilitator: Address, intent: PaymentIntent): Hex {
  return hashTypedData({
    domain: intentDomain(facilitator),
    types: intentTypes,
    primaryType: "PaymentIntent",
    message: intent,
  });
}

/** viem returns a packed 65-byte signature; the contract takes v, r, s. */
export function split(sig: Hex): SplitSignature {
  return {
    r: `0x${sig.slice(2, 66)}` as Hex,
    s: `0x${sig.slice(66, 130)}` as Hex,
    v: parseInt(sig.slice(130, 132), 16),
  };
}
