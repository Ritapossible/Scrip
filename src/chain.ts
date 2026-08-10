/**
 * Coston2 network definition and the one address worth hardcoding.
 *
 * The chain is defined inline rather than imported from viem/chains: the export
 * names there distinguish Coston from Coston2 by a suffix that is easy to get
 * wrong, and a silent wrong-network connection is an expensive hour.
 */

import { defineChain } from "viem";

export const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] },
  },
  blockExplorers: {
    default: {
      name: "Coston2 Explorer",
      url: "https://coston2-explorer.flare.network",
    },
  },
  testnet: true,
});

/**
 * The FlareContractRegistry sits at the same address on every Flare network,
 * so this is the single constant worth hardcoding. Everything else - the asset
 * manager, the FXRP token, the FTSO feeds - is resolved through it at runtime,
 * which keeps this working across a redeployment.
 */
export const FLARE_CONTRACT_REGISTRY =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

export const txUrl = (hash: string): string =>
  `${coston2.blockExplorers.default.url}/tx/${hash}`;

export const addressUrl = (address: string): string =>
  `${coston2.blockExplorers.default.url}/address/${address}`;
