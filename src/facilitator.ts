/**
 * The facilitator: the half of x402 that talks to the chain.
 *
 * `verify` answers "would this payment succeed?" without spending anything.
 * `settle` submits it and pays the gas. They are separate because a resource
 * server wants to reject a bad payment before it costs a transaction, and
 * because the x402 spec exposes them as separate endpoints.
 *
 * Everything `verify` checks is something `settle()` would otherwise revert on.
 * Reverts are cheap to cause and expensive to diagnose, so the checks are done
 * here where each one can say what is wrong in a sentence.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  getAddress,
  recoverAddress,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "./chain.js";
import { fxrpAbi, facilitatorAbi, explainRevert } from "./abi.js";
import { resolveFxrp, type FxrpInfo } from "./fxrp.js";
import { resolveFtsoV2 } from "./ftso.js";
import { intentDigest, type PaymentIntent } from "./eip712.js";
import {
  assertPayload,
  type PaymentPayload,
  type PaymentResponse,
  NETWORK,
} from "./x402.js";

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  payer?: Address;
  /**
   * A stable identifier for why a payment was rejected, for the cases a caller
   * needs to act on rather than display. Matching on `reason` would work until
   * somebody improves the wording.
   */
  code?: "already-settled" | "expired" | "payee-not-allowed";
}

export interface SettleResult extends PaymentResponse {}

/**
 * The facilitator is bound to a token the registry no longer resolves to.
 *
 * Distinguished from every other startup failure because it is the only one
 * waiting cannot fix: `token` is immutable, so this needs a redeployment, while
 * an unreachable RPC needs a minute. A service that treats them alike either
 * retries forever on a permanent fault or gives up permanently on a transient
 * one - and the second is how a deploy dies on a network hiccup.
 */
export class FxrpBindingError extends Error {
  override readonly name = "FxrpBindingError";
}

/** Rebuild the strongly typed intent from the JSON that came over the wire. */
function toIntent(payload: PaymentPayload): PaymentIntent {
  const i = payload.payload.intent;
  return {
    invoiceId: i.invoiceId,
    payer: getAddress(i.payer),
    payee: getAddress(i.payee),
    amount: BigInt(i.amount),
    deadline: BigInt(i.deadline),
  };
}

function packSignature(sig: { v: number; r: Hex; s: Hex }): Hex {
  return `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.v.toString(16).padStart(2, "0")}` as Hex;
}

export class Facilitator {
  readonly address: Address;
  readonly client: PublicClient;
  private readonly wallet: WalletClient;
  readonly relayer: Address;
  private fxrpCache?: FxrpInfo;
  private ftsoCache?: Address;
  /** Payees this facilitator will spend gas for. Empty means anyone. */
  readonly payeeAllowlist: readonly Address[];

  constructor(opts: {
    facilitator: Address;
    relayerKey: Hex;
    rpcUrl?: string;
    payeeAllowlist?: readonly Address[];
  }) {
    // The public Coston2 RPC is slow on a cold call, well past viem's 10s default.
    const transport = http(opts.rpcUrl, { timeout: 45_000, retryCount: 3 });
    const account = privateKeyToAccount(opts.relayerKey);

    this.address = getAddress(opts.facilitator);
    this.client = createPublicClient({ chain: coston2, transport });
    this.wallet = createWalletClient({ account, chain: coston2, transport });
    this.relayer = account.address;
    this.payeeAllowlist = (opts.payeeAllowlist ?? []).map(getAddress);
  }

  /**
   * `settle()` is permissionless in the contract, and deliberately so - it is why
   * the PaymentIntent exists. That is the right property for the contract and the
   * wrong one for a relayer key on the open internet, which pays gas for whatever
   * it is handed. The contract cannot tell those apart; this service can.
   *
   * An empty allowlist keeps the old behaviour, because a facilitator run locally
   * against your own endpoints has nobody to defend against and configuring one
   * would only be a way to lock yourself out.
   */
  private payeeRejection(payee: Address): string | undefined {
    if (this.payeeAllowlist.length === 0) return undefined;
    if (this.payeeAllowlist.includes(getAddress(payee))) return undefined;
    return (
      `payee ${payee} is not on this facilitator's allowlist. It pays gas only ` +
      `for payments to addresses it was configured to serve.`
    );
  }

  /** FXRP never changes within a process run, so resolve it once. */
  async fxrp(): Promise<FxrpInfo> {
    this.fxrpCache ??= await resolveFxrp(this.client);
    return this.fxrpCache;
  }

  /**
   * FtsoV2's address comes from the same registry and changes just as rarely, so
   * looking it up on every quote was a round trip to a public RPC for an answer
   * that does not move. The feed reading itself is never cached - that is the
   * part that has to be current.
   */
  async ftsoV2(): Promise<Address> {
    this.ftsoCache ??= await resolveFtsoV2(this.client);
    return this.ftsoCache;
  }

  /**
   * The facilitator's `token` is immutable, so one bound to a stale FXRP can
   * never be fixed, only redeployed. Checked at startup rather than discovered
   * inside a revert during a demo.
   */
  async assertBoundToCurrentFxrp(): Promise<void> {
    const fxrp = await this.fxrp();
    const bound = await this.client.readContract({
      address: this.address,
      abi: facilitatorAbi,
      functionName: "token",
    });
    if (getAddress(bound) !== getAddress(fxrp.address)) {
      throw new FxrpBindingError(
        `facilitator is bound to ${bound} but the registry resolves FXRP to ` +
          `${fxrp.address}. Redeploy the facilitator against the current token.`,
      );
    }
  }

  async isSettled(invoiceId: Hex): Promise<boolean> {
    return this.client.readContract({
      address: this.address,
      abi: facilitatorAbi,
      functionName: "settled",
      args: [invoiceId],
    });
  }

  /**
   * Everything that can be known without spending gas. Ordered cheapest-first so
   * an obviously malformed payment never reaches an RPC round trip.
   */
  async verify(
    raw: unknown,
    expected?: { invoiceId?: Hex; payee?: Address; amount?: bigint },
  ): Promise<VerifyResult> {
    try {
      assertPayload(raw);
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const payload = raw as PaymentPayload;
    let intent: PaymentIntent;
    try {
      intent = toIntent(payload);
    } catch (err) {
      return { valid: false, reason: `malformed intent: ${(err as Error).message}` };
    }

    // The server issued these terms; a client that signed different ones is
    // paying for something other than what it asked for.
    if (expected?.invoiceId && intent.invoiceId.toLowerCase() !== expected.invoiceId.toLowerCase()) {
      return { valid: false, reason: "intent invoiceId does not match the issued invoice" };
    }
    if (expected?.payee && getAddress(expected.payee) !== intent.payee) {
      return { valid: false, reason: "intent payee does not match the issued payee" };
    }

    // Checked before any RPC call: refusing costs nothing, and the answer cannot
    // change with the state of the chain.
    const rejected = this.payeeRejection(intent.payee);
    if (rejected) return { valid: false, code: "payee-not-allowed", reason: rejected };
    if (expected?.amount !== undefined && intent.amount < expected.amount) {
      return {
        valid: false,
        reason: `intent amount ${intent.amount} is below the invoiced ${expected.amount}`,
      };
    }

    const [block, alreadySettled, fxrp] = await Promise.all([
      this.client.getBlock(),
      this.isSettled(intent.invoiceId),
      this.fxrp(),
    ]);

    if (alreadySettled) {
      return {
        valid: false,
        code: "already-settled",
        reason: `invoice ${intent.invoiceId} has already been settled`,
      };
    }
    if (intent.deadline <= block.timestamp) {
      return {
        valid: false,
        code: "expired",
        reason: `intent expired at ${intent.deadline}, chain time is ${block.timestamp}`,
      };
    }

    // The contract's own digest is the authority on what should have been
    // signed. Recovering against it here catches a domain mismatch as a sentence
    // rather than as IntentNotSignedByPayer later.
    const onchainDigest = await this.client.readContract({
      address: this.address,
      abi: facilitatorAbi,
      functionName: "intentDigest",
      args: [intent],
    });
    const localDigest = intentDigest(this.address, intent);
    if (localDigest.toLowerCase() !== onchainDigest.toLowerCase()) {
      return {
        valid: false,
        reason: "intent digest mismatch between this service and the facilitator contract",
      };
    }

    let recovered: Address;
    try {
      recovered = await recoverAddress({
        hash: onchainDigest,
        signature: packSignature(payload.payload.intentSignature),
      });
    } catch (err) {
      return { valid: false, reason: `intent signature is unrecoverable: ${(err as Error).message}` };
    }
    if (getAddress(recovered) !== intent.payer) {
      return {
        valid: false,
        reason: `intent signature recovered to ${recovered}, not the payer ${intent.payer}`,
      };
    }

    // A signature that verifies against an empty wallet still cannot pay.
    const balance = await this.client.readContract({
      address: fxrp.address,
      abi: fxrpAbi,
      functionName: "balanceOf",
      args: [intent.payer],
    });
    if (balance < intent.amount) {
      return {
        valid: false,
        reason: `payer holds ${balance} ${fxrp.symbol} base units, needs ${intent.amount}`,
      };
    }

    // Everything above is a check this service can make on its own. The permit
    // signature is not one of them: it is verified inside FXRP, against a
    // vendored ERC20Permit, and the only honest way to know it will be accepted
    // is to ask. Simulating the whole call covers the permit, the resulting
    // allowance and any transfer fee in a single eth_call, so `valid: true`
    // means the transaction would actually go through rather than merely that
    // the parts this service can see look right.
    try {
      await this.simulate(payload);
    } catch (err) {
      return { valid: false, reason: describeError(err) };
    }

    return { valid: true, payer: intent.payer };
  }

  /** Dry-run settle() as the relayer. Throws a decodable revert on failure. */
  private async simulate(payload: PaymentPayload) {
    const intent = toIntent(payload);
    const { request } = await this.client.simulateContract({
      address: this.address,
      abi: facilitatorAbi,
      functionName: "settle",
      args: [intent, payload.payload.permitSignature, payload.payload.intentSignature],
      account: this.wallet.account!,
    });
    return request;
  }

  /** Submit the payment. The relayer signs and pays; the payer sends nothing. */
  async settle(raw: unknown): Promise<SettleResult> {
    try {
      assertPayload(raw);
    } catch (err) {
      return { success: false, network: NETWORK, error: (err as Error).message };
    }

    const payload = raw as PaymentPayload;
    const intent = toIntent(payload);

    // Enforced here as well as in verify(), because settle() is reachable
    // directly and a check that only guards the polite path guards nothing.
    const rejected = this.payeeRejection(intent.payee);
    if (rejected) return { success: false, network: NETWORK, error: rejected };

    try {
      // Simulate first so a payment that cannot succeed costs nobody any gas,
      // and so the failure arrives as a named custom error rather than as a
      // receipt with status 0 and nothing to say about why.
      const request = await this.simulate(payload);
      const hash = await this.wallet.writeContract(request);

      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { success: false, network: NETWORK, transaction: hash, error: "transaction reverted" };
      }

      const event = receipt.logs
        .filter((log) => getAddress(log.address) === this.address)
        .flatMap((log) => {
          try {
            return [decodeEventLog({ abi: facilitatorAbi, data: log.data, topics: log.topics })];
          } catch {
            return [];
          }
        })
        .find((e) => e.eventName === "PaymentSettled");

      const delivered =
        event?.eventName === "PaymentSettled" ? event.args.delivered : intent.amount;

      return {
        success: true,
        network: NETWORK,
        transaction: hash,
        blockNumber: receipt.blockNumber.toString(),
        payer: intent.payer,
        delivered: delivered.toString(),
        gasUsed: receipt.gasUsed.toString(),
        gasPaidBy: getAddress(receipt.from),
      };
    } catch (err) {
      return { success: false, network: NETWORK, error: describeError(err) };
    }
  }
}

/** Turn a viem revert into the facilitator's own sentence about it. */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      const { errorName, args = [] } = revert.data;
      return `${errorName}: ${explainRevert(errorName, args)}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
