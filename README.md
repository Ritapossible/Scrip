# Scrip

**Machine-payable FXRP. Agents pay for what they use, priced in USD, settled on Flare.**

An AI agent hits a paid API. The server answers `402` with a price in US dollars.
The agent signs one offchain message. The service is paid in FXRP at the live
FTSO rate. The agent never sends a transaction and never holds a gas token.

Built for [Flare Summer Signal](https://dorahacks.io/hackathon/flaresummersignal/)
on Coston2.

---

## Status

Nothing below is aspirational. Everything marked working has been run against
live Coston2.

| Piece | State |
|---|---|
| Chain probe - resolves FXRP, verifies the EIP-712 domain | working, live Coston2 |
| `ScripFacilitator.sol` | written, not yet deployed |
| Gasless settlement (`settle.ts`) | next |
| FTSO USD pricing | next |
| x402 facilitator service + Express middleware | next |
| MCP server so an assistant can spend | next |
| Live figures on the web dashboard | placeholders, wired after settlement lands |

---

## Why Flare, specifically

The point of the project is that it does not port to another chain by
find-and-replace.

- **FAssets / FXRP** is the settlement asset. FAssets gives XRP a way *onto*
  Flare; almost nothing gives it a reason to *move*. This is a demand-side use
  for the bridged asset.
- **FTSO** prices every invoice. Invoices are denominated in USD and settled in
  FXRP at Flare's enshrined onchain price feed, so the oracle is load-bearing
  rather than decorative.
- **EIP-2612, not EIP-3009.** FXRP implements `permit`, not
  `transferWithAuthorization`. Every x402 implementation written for USDC
  assumes the latter, so the signing path here had to be built against Flare's
  actual token rather than adapted from a tutorial.

---

## How a payment works

```
agent  --GET-->     endpoint      402 + price in USD
agent  --sign-->    permit        offchain, no gas, no transaction
relay  --settle()-> Flare         permit + transferFrom, relayer pays gas
agent  <--200--     endpoint      resource delivered
```

The payer signs an EIP-2612 permit. `ScripFacilitator.settle()` submits it,
moves FXRP to the payee, and binds the payment to an invoice ID so the same
signature cannot be replayed before its deadline.

Two details in the contract are worth knowing about:

**It measures what actually arrived.** FAssets parameters are asset-manager
controlled and may levy a transfer fee, so `settle()` reads the payee balance
before and after and reverts with `Underdelivered` if the payee received less
than the invoice. A payment rail that silently underpays is a broken one.

**The permit call is not yet wrapped in `try/catch`.** That is deliberate while
the flow is being proven - a bad signature should revert with a readable reason
rather than fail later as an opaque allowance error. It gets wrapped once
signing is confirmed end to end, because in production a front-runner can
consume the permit from the mempool and the `transferFrom` is what actually has
to succeed.

---

## What the probe found

`npm run probe` reads every fact the facilitator depends on rather than
inferring it. That matters because FXRP ships a **vendored** `ERC20Permit`
rather than stock OpenZeppelin, so anything taken from upstream documentation is
a guess.

Three results from the live run:

1. **Signatures will verify.** The EIP-712 domain rebuilt from `eip712Domain()`
   (IERC5267) matches the token's own `DOMAIN_SEPARATOR` exactly. This was the
   highest-risk unknown in the design - a forked domain would make every permit
   revert with no useful error.
2. **`decimals` is 6, not 18.** Flare's minting guide suggests a standard 18.
   Hardcoding that would put every invoice off by a factor of 10^12.
3. **FXRP is resolved, not hardcoded** - registry → `AssetManagerFXRP` →
   `fAsset()` - so a redeployment does not break the code.

---

## Addresses (Coston2)

| Contract | Address |
|---|---|
| FXRP | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| ScripFacilitator | not yet deployed |

The testnet token reports its symbol as `FTestXRP` and its name as `FXRP`. Use
the value the contract returns rather than assuming either.

---

## Run it

Node 20 or newer. Nothing else - no Rust, no local node.

```bash
git clone https://github.com/Ritapossible/Scrip.git
cd Scrip
npm install
npm run probe     # read-only, no keys, no gas
npm run web       # http://127.0.0.1:8080
```

Use `npm run web` rather than a plain static server: the pages link to `./docs`
without an extension, which production resolves through Vercel's `cleanUrls`. A
plain server returns 404 for it, so the Docs link and every menu entry look
broken when the site is fine.

To go further, copy `.env.example` to `.env` and fill in three throwaway
wallets:

- **PAYER** holds FXRP and deliberately **zero C2FLR**. That zero is the proof:
  it is what makes the payment gasless from the agent's side.
- **RELAYER** holds C2FLR only and pays every gas fee.
- **PAYEE** just receives.

Fund them from the [Coston2 faucet](https://faucet.flare.network/coston2), which
dispenses both C2FLR and FXRP.

Two environment notes that cost time otherwise: the public Coston2 RPC times out
on a cold call well past viem's 10 second default, so the transport here is set
to 45 seconds with retries. And Windows PowerShell 5.1 negotiates TLS 1.0 by
default, which Flare's RPC rejects - force TLS 1.2 before using
`Invoke-WebRequest` against it. Node's `fetch` is unaffected.

---

## Layout

```
contracts/
  ScripFacilitator.sol   settles one invoice, binds it, checks delivery
src/
  chain.ts               Coston2 definition + the contract registry address
scripts/
  probe.ts               read-only: resolve FXRP, verify the signing domain
  serve-web.mjs          local server matching production URL rules
web/
  index.html             landing page
  docs.html              reference
  app.js                 site menu
  styles.css             design system
vercel.json              static hosting, no build step
```

---

## Known limitation

EIP-2612 nonces are sequential per payer, so an agent paying two endpoints
concurrently will have the second permit fail on a consumed nonce. EIP-3009's
random nonces avoid this, but FXRP does not implement EIP-3009. Payments are
serialised per payer until that is addressed.

---

## Roadmap

Deploy the facilitator, land a gasless settlement on Coston2, add FTSO pricing,
then ship the x402 facilitator service and the Express middleware so any Flare
service can charge for a request in about five lines.

---

## License

MIT
