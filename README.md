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
| `ScripFacilitator.sol` | deployed and source-verified on Coston2 |
| `settle()` end to end - real FXRP, real signatures | working, on a fork of live Coston2 |
| Gasless settlement against deployed Coston2 (`settle.ts`) | next |
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
agent  --sign-->    permit+intent offchain, no gas, no transaction
relay  --settle()-> Flare         permit + transferFrom, relayer pays gas
agent  <--200--     endpoint      resource delivered
```

The payer signs twice, offchain. `ScripFacilitator.settle()` submits both,
moves FXRP to the payee, and binds the payment to an invoice ID so the same
signatures cannot be replayed before their deadline.

Three details in the contract are worth knowing about:

**It takes two signatures, not one.** An EIP-3009 authorisation names its
recipient; an EIP-2612 permit does not - it commits only to
`(owner, spender, value, nonce, deadline)` and says nothing about where the
money then goes. Since `settle()` is permissionless so that any relayer can
carry a payment, a permit alone would let anyone who observed the signature call
`settle()` naming themselves as payee. So the payer also signs a `PaymentIntent`
over this contract's own EIP-712 domain, naming the invoice, the payee and the
amount. The permit authorises the allowance; the intent authorises the
destination. Neither is sufficient alone.

**It measures what actually arrived.** FAssets parameters are asset-manager
controlled and may levy a transfer fee, so `settle()` reads the payee balance
before and after and reverts with `Underdelivered` if the payee received less
than the invoice. A payment rail that silently underpays is a broken one.

**The permit call is wrapped in `try/catch`.** A front-runner can lift the permit
out of the mempool and submit it directly, which consumes the nonce and makes a
bare `permit` call here revert - griefing every payment on the rail for the price
of gas. Swallowing that revert is only safe because the intent has already fixed
the destination, so a griefer who replays the permit just moves the allowance
into place and gains nothing. The allowance is then checked explicitly, so a
genuinely missing one still reports itself rather than failing opaquely inside
the token.

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

## What the fork test proves

`npm run test:fork` forks live Coston2, deploys the facilitator onto the fork,
and settles a real invoice against the **real FXRP contract** with real
signatures. The token is not a mock: it is the deployed vendored FAsset,
resolved through `AssetManagerFXRP.fAsset()` the same way `probe.ts` resolves
it. The payer's FXRP balance *is* synthetic - written straight into the token's
balance mapping on the fork, because minting FAssets legitimately requires an
XRP payment proof that a test cannot produce.

```bash
anvil --fork-url https://coston2-api.flare.network/ext/C/rpc --port 8546
forge build
npm run test:fork
```

Five properties, each asserted rather than asserted-about:

1. **The payment is gasless.** The payer's native balance is set to zero before
   signing and checked to still be zero afterwards. A payer holding no C2FLR
   pays a 1.5 FXRP invoice; the relayer's address is the one on the receipt.
2. **The signatures verify against FXRP's vendored `permit`.** Not against a
   mock, and not against stock OpenZeppelin.
3. **A relayer cannot redirect the payment.** A third account calls `settle()`
   substituting itself as payee and is rejected with `IntentNotSignedByPayer`.
   This is the hole the PaymentIntent exists to close, so it is tested as an
   attack rather than assumed.
4. **An invoice settles once.** Replaying the same signatures reverts with
   `AlreadySettled`.
5. **A front-runner cannot grief a payment.** A third account lifts the permit
   and submits it straight to FXRP, consuming the nonce. `settle()` still
   delivers the full amount - which is the entire justification for the
   `try/catch`.

## Addresses (Coston2)

| Contract | Address |
|---|---|
| FXRP | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| ScripFacilitator | `0x43F672C0a915F59A2472a07D2108936e217cB04C` |

[ScripFacilitator on the explorer][fac], source-verified. Deployed in block
33930955, tx
`0x2bf4a067e1cbfc75a560639a1157f5ae059d35158568df342f47a7777f152aa9`.

[fac]: https://coston2-explorer.flare.network/address/0x43F672C0a915F59A2472a07D2108936e217cB04C

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
  settle-fork-test.mjs   settles a real invoice against a fork of live Coston2
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

`settled` is keyed on `invoiceId` alone, not on `(invoiceId, payer)`. Invoice
IDs travel the x402 HTTP path, so anyone who sees one can settle their own
payment against it first and burn it for the intended payer. No funds are at
risk - the intent still binds payer, payee and amount - but the service has to
reissue. Namespacing invoice IDs per payer would close it.

---

## Roadmap

Land a gasless settlement against the deployed facilitator on live Coston2, add
FTSO pricing, then ship the x402 facilitator service and the Express middleware
so any Flare service can charge for a request in about five lines.

---

## License

MIT
