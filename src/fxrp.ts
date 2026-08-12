/**
 * Resolve FXRP the way the chain says to, not the way a tutorial says to.
 *
 * registry -> AssetManagerFXRP -> fAsset(). A redeployment of the FAsset does
 * not break anything that goes through here. The token's decimals and EIP-712
 * domain are read from the token itself: FXRP ships a vendored ERC20Permit
 * rather than stock OpenZeppelin, and its decimals are 6 where Flare's own
 * minting guide suggests 18.
 */

import { type Address, type PublicClient } from "viem";
import { FLARE_CONTRACT_REGISTRY } from "./chain.js";
import { registryAbi, assetManagerAbi, fxrpAbi } from "./abi.js";

export interface FxrpInfo {
  address: Address;
  decimals: number;
  symbol: string;
  /** The token's own EIP-712 domain, rebuilt from eip712Domain() (IERC5267). */
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
}

export async function resolveContract(
  client: PublicClient,
  name: string,
): Promise<Address> {
  return client.readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: [name],
  });
}

export async function resolveFxrp(client: PublicClient): Promise<FxrpInfo> {
  const assetManager = await resolveContract(client, "AssetManagerFXRP");
  const address = await client.readContract({
    address: assetManager,
    abi: assetManagerAbi,
    functionName: "fAsset",
  });

  const [decimals, symbol, domain] = await Promise.all([
    client.readContract({ address, abi: fxrpAbi, functionName: "decimals" }),
    client.readContract({ address, abi: fxrpAbi, functionName: "symbol" }),
    client.readContract({ address, abi: fxrpAbi, functionName: "eip712Domain" }),
  ]);

  return {
    address,
    decimals,
    symbol,
    domain: {
      name: domain[1],
      version: domain[2],
      chainId: Number(domain[3]),
      verifyingContract: domain[4],
    },
  };
}
