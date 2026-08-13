# Scrip

**Machine-payable FXRP. Agents pay for what they use, priced in USD, settled on Flare.**

An AI agent hits a paid API. The server answers `402` with a price in US dollars.
The agent signs two offchain messages. The service is paid in FXRP at the live
FTSO rate. The agent never sends a transaction and never holds a gas token.

Built for [Flare Summer Signal](https://dorahacks.io/hackathon/flaresummersignal/)
on Coston2.

---

## Try it without installing anything

The facilitator is live at
**[scrip-production.up.railway.app](https://scrip-production.up.railway.app)**.

```bash
BASE=https://scrip-production.up.railway.app

curl $BASE/health              # bound to the current FXRP, and says so
curl $BASE/price               # the live XRP/USD feed it bills against
curl -i $BASE/api/haiku        # 402, priced in FXRP at that feed, right now
```

That 402 is the product. It carries a USD price, the FXRP amount it converts to,
the rate it was derived from so you can check the conversion yourself, and a
single-use invoice id. To pay one, clone the repo and point the agent at it:

```bash
npm run agent -- https://scrip-production.up.railway.app/api/haiku
```

---

## Who it is for

**Primarily: developers building agents that consume paid APIs.** An agent that
has to pay for something today needs a gas token on the settlement chain, a
process to keep topping it up, and a key that can send transactions - three
problems that have nothing to do with the thing it was built to do. Scrip removes
all three. The agent holds FXRP, signs two messages offchain, and sends no
transaction. Its native balance is zero at the start and zero at the end.

**Also: operators of APIs that want to charge per call.** Charging for a route is
one argument - `requirePayment({ usd: "0.25" })` - and the resource server never
holds a key or runs a relayer, because the facilitator does both. A service can
point at a facilitator someone else hosts and start billing in FXRP without
touching a wallet.

**And: FAssets itself.** FAssets gives XRP a way onto Flare. Very little gives it
a reason to move once it is there, and a bridged asset that only sits still is a
bridge with one direction. This is a demand-side use for FXRP - somewhere the
asset is spent rather than held.

The three roles the rail needs - payer, relayer, payee - are described under
[Run it](#run-it).

---

## Status

Nothing below is aspirational. Everything marked working has been run against
live Coston2.

| Piece | State |
|---|---|
| Chain probe - resolves FXRP, verifies the EIP-712 domain | working, live Coston2 |
| `ScripFacilitator.sol` | deployed and source-verified on Coston2 |
| `settle()` end to end - real FXRP, real signatures | working, on a fork of live Coston2 |
| Gasless settlement (`settle.ts`) | **working, live Coston2** - [tx `0x4bea1e37`][tx1] |
| FTSO USD pricing | **working, live Coston2** - invoices priced at the live XRP/USD feed |
| x402 facilitator service + Express middleware | **hosted and public** - [scrip-production.up.railway.app][live] |
| An agent paying a 402 holding no gas token | **working, live Coston2** - [tx `0x975a5ac6`][tx2] |
| An agent paying the *hosted* facilitator | **working, live Coston2** - [tx `0xe3cb0532`][tx4] |
| MCP server - an assistant prices, quotes and pays in conversation | **working, live Coston2** - [tx `0xeeef2e1d`][tx3] |
| Payee allowlist - the relayer spends gas only for payees it was configured to serve | **enforced on the hosted facilitator** |
| A spent invoice is answered with a fresh quote, and the client re-signs | **working, live Coston2** |

[tx1]: https://coston2-explorer.flare.network/tx/0x4bea1e3775332d6f289a66ced078caa400ae3b524b4097a2b41b39d22147d2b4
[tx2]: https://coston2-explorer.flare.network/tx/0x975a5ac6625db3e292cd4e12c3952a3e2daa6178fd04297a1158ea3c68c336d2
[tx3]: https://coston2-explorer.flare.network/tx/0xeeef2e1d32468fc71d44695a1995745af0a4b53e2a228c9a66dfe14b8cd6b46d
[tx4]: https://coston2-explorer.flare.network/tx/0xe3cb0532e8824c8ab780ddcacb637ed1aa4ed19a6646764787a63ad6e47d9098
[live]: https://scrip-production.up.railway.app

---

## Built during Flare Summer Signal

All of it. There was no existing product to port and nothing was carried in from
before the program: the repository's first commit is 10 August 2026 and it has no
history behind it. Every file listed under [Layout](#layout) was written during
the hackathon, against Coston2.

| Day | What landed |
|---|---|
| 10 Aug | FXRP resolved through the registry rather than hardcoded; the token's EIP-712 domain rebuilt from `eip712Domain()` and checked against its own `DOMAIN_SEPARATOR` |
| 11 Aug | `ScripFacilitator.sol` - two-signature settlement, delivery measured on arrival; deployed and source-verified on Coston2; the fork test, including the three attacks; the first gasless payment on live Coston2 |
| 12 Aug | The x402 rail - facilitator service, `requirePayment()` middleware, FTSO-priced invoices, and an agent that pays a 402 holding no gas token |
| 13 Aug | The MCP server and its spending caps; hosting for the facilitator; the site |

**What was integrated rather than written:** FAssets (FXRP as the settlement
asset), FTSO (the XRP/USD feed every invoice is priced at), and the Flare
contract registry (which resolves both, so a redeployment of either does not
break this code). The x402 shape follows the spec's `accepts` / `X-PAYMENT`
structure; the deviation from it, and why it was necessary, is described under
[How a payment works](#how-a-payment-works).

**What took the longest was not what looks hardest.** The contract is
straightforward. The expensive part was establishing what FXRP actually does -
that it ships a vendored `ERC20Permit` rather than stock OpenZeppelin, that its
`decimals` is 6 where Flare's own minting guide suggests 18, and that it
implements EIP-2612 rather than the EIP-3009 every x402 implementation in the
wild assumes. Each of those was read off the chain rather than taken from
documentation, and the third one is why the signing path had to be designed
rather than copied.

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

## The rail, end to end, on live Coston2

`npm run serve:x402` starts the facilitator and one paid endpoint.
`npm run agent` is an agent with FXRP, no gas token, and no idea what anything
costs until it asks.

The facilitator exposes `GET /supported`, `POST /verify` and `POST /settle`, so
a resource server can point at it without running a relayer or holding a key. A
client speaking the USDC dialect of x402 is turned away with a reason rather
than a revert:

```
$ curl -s -X POST https://scrip-production.up.railway.app/verify \
    -H 'content-type: application/json' \
    -d '{"x402Version":1,"scheme":"exact"}'

{"valid":false,"reason":"unsupported scheme \"exact\". This rail settles FXRP,
which implements EIP-2612 permit rather than EIP-3009, so it uses
\"exact-permit2612\" and requires two signatures: a permit and a PaymentIntent."}
```

The `content-type` header matters: without it `express.json()` skips the body
and you get a complaint about a missing `x402Version` instead.

```
402 payment required
  price              $0.25
  amount             0.244356 FTestXRP
  XRP/USD            $1.023099
  invoice            0xdeb6e1c4...
  PASS  quoted amount matches the quoted rate
  PASS  intent digest agrees with the facilitator

signed two messages, sent no transaction

200 OK
  {"haiku":["Ledger holds its breath","a signature, then the coin","moves without a fee"]}

settled
  tx                 0x975a5ac6625db3e292cd4e12c3952a3e2daa6178fd04297a1158ea3c68c336d2
  block              33961951
  delivered          0.244356 FTestXRP
  gas used           205702
  gas paid by        0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
  payer C2FLR        0 -> 0

  PASS  the agent paid for an API call holding no gas token at all
```

Charging for a route is one argument:

```ts
app.get("/api/haiku", requirePayment({ facilitator, payee, usd: "0.25" }), (req, res) => {
  res.json({ haiku: HAIKU });
});
```

Three details worth knowing:

**The scheme is `exact-permit2612`, not `exact`.** Every x402 implementation in
the wild is written against USDC, whose EIP-3009 authorisation names its
recipient inside the signed message. FXRP implements EIP-2612 `permit`, which
does not. A USDC-shaped client would produce a signature this rail cannot use,
so it is told that by the scheme name rather than by a revert.

**The agent checks the invoice before paying it.** It recomputes the FXRP amount
from the rate the server showed its working for, and refuses if they disagree.
It also checks its locally built intent digest against the facilitator's own
`intentDigest()` before signing. A client that signs whatever a server puts in
front of it is not a payment rail.

**Quotes are stateless.** The invoice id is an HMAC over
(resource, amount, deadline) keyed by a server secret, so a returning payment
proves the service issued that exact quote without anything having been stored.
An in-memory map of issued invoices would be wrong behind a load balancer and
forgetful across a restart, and both failures look like a client that paid and
got nothing.

**A spent quote is answered with another quote.** Invoice ids travel the HTTP
path in the clear, so anyone who sees one can settle their own payment against it
first and leave the intended payer holding a signature for something that can
never settle. No funds are at risk - the intent binds payer, payee and amount -
and rather than return an error the service issues a fresh quote, which the
client signs and pays. The recovery is automatic in both halves: `pay.ts` retries
once, and only once, because a second failure is a real failure and retrying
forever would turn a broken endpoint into a loop that spends money.

**The facilitator only pays gas for payees it was told about.**
`SCRIP_PAYEE_ALLOWLIST` names them, checked in both `verify` and `settle` before
any RPC call. `settle()` is permissionless in the contract, deliberately - it is
why the `PaymentIntent` exists, and it is what lets any relayer carry a payment -
but that also means an exposed facilitator would pay gas for whatever it is
handed. The contract cannot tell an intended payee from a stranger's; the service
can. Unset means anyone, which is right for a local run against your own
endpoints and wrong for a public one.

---

## An assistant that can spend

`npm run mcp` starts an MCP server over stdio. Everything else in this repo is an
agent that was told what to buy; this is the piece that lets an assistant decide -
ask what a resource costs, say so, and pay for it inside a conversation.

Point a client at it. For Claude Code, `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "scrip": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/Scrip"
    }
  }
}
```

Five tools. Four of them cannot spend anything:

| Tool | Does |
|---|---|
| `price` | What is $X in FXRP right now, at the live FTSO feed |
| `quote` | Fetch a paid URL, report the price and the checks, pay nothing |
| `wallet` | Payer address, FXRP balance, C2FLR balance, budget left |
| `facilitator` | Is this facilitator reachable, and does it speak our scheme |
| `pay` | **Spends FXRP.** Pays a 402 and returns the resource and the receipt |

A conversation looks like this:

```
> what does the haiku endpoint cost?

  quote → $0.25 = 0.248544 FTestXRP at $1.005861/XRP
          PASS  asset is the registry's FXRP
          PASS  quoted amount matches the quoted rate

> go ahead

  pay   → 200, haiku delivered
          tx           0xeeef2e1d…  block 34018086
          delivered    0.248429 FTestXRP
          gas paid by  0xaA34e14a…
          payer C2FLR  0 -> 0
          spent        $0.25 of $5.00 this session
```

**Handing a language model a spending key deserves more than a tool definition.**
Two limits sit in front of `pay`, and neither can be raised by anything the model
or the resource server says:

- `SCRIP_MAX_USD_PER_CALL` (default `$1.00`), checked against the quote's USD
  price before a signature exists. A `maxUsd` argument can lower it for one call
  and can never raise it.
- `SCRIP_MAX_USD_SESSION` (default `$5.00`), accumulated across every payment the
  process makes and not resettable without restarting it.

They are enforced in the client, because a cap the server sets is not a cap. The
payer's FXRP balance is the third and hardest limit: it holds no gas token, so
the worst case for a key that leaks is the FXRP sitting in it.

Without `PAYER_PK` the server still starts and still prices, quotes and inspects
facilitators. Refusing to run without a spending key would trade all of that away
for nothing.

The payment path itself is `src/pay.ts`, shared with `scripts/agent.ts` - a
payment path that exists twice is one where only one copy gets fixed.

---

## What the fork test proves

`npm run test:fork` forks live Coston2, deploys the facilitator onto the fork,
and settles a real invoice against the **real FXRP contract** with real
signatures. The token is not a mock: it is the deployed vendored FAsset,
resolved through `AssetManagerFXRP.fAsset()` the same way `probe.ts` resolves
it. The payer's balance is written directly into the token's balance mapping,
because minting FAssets legitimately requires an XRP payment proof that no test
can produce - so the fork exercises the contract logic and the signing path
against the genuine token. The funding route is covered live instead: the
payments listed under [Addresses](#addresses-coston2) are on Coston2, from a
payer holding FXRP it was actually sent.

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

Two payments on live Coston2, both with the payer's C2FLR at zero before and
after:

| Payment | Block | Gas | Transaction |
|---|---|---|---|
| 0.5 FXRP, direct | 33961376 | 222,790 | [`0x4bea1e37`][tx1] |
| $0.25 via x402 | 33961951 | 205,702 | [`0x975a5ac6`][tx2] |
| $0.25 via the MCP `pay` tool | 34018086 | 205,698 | [`0xeeef2e1d`][tx3] |
| $0.25 against the hosted facilitator | 34022538 | 205,722 | [`0xe3cb0532`][tx4] |

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

To go further you need two funded wallets. Fund one from the
[Coston2 faucet](https://faucet.flare.network/coston2) - it dispenses both C2FLR
and FXRP - then:

```bash
RELAYER_PK=0x<that wallet's key> npm run setup   # generates a fresh payer, writes .env
npm run fund -- 2                                # moves 2 FXRP to the payer
```

That gives you the three roles the rail needs:

- **PAYER** holds FXRP and deliberately **zero C2FLR**. That zero is the proof:
  it is what makes the payment gasless from the agent's side.
- **RELAYER** holds C2FLR only and pays every gas fee.
- **PAYEE** just receives. It defaults to the relayer, which is fine - nothing
  requires them to differ.

The payer is generated fresh rather than reused from a funded wallet on purpose.
`settle.ts` asserts the payer's native balance is *exactly* zero, and you cannot
drain an account to exactly zero - the drain transaction burns gas and leaves
dust. Only a wallet that has never received C2FLR satisfies that equality.

Then price something, and settle it:

```bash
npm run price            # what is $0.25 in FXRP right now?
npm run settle           # pays 0.5 FXRP against the deployed facilitator
npm run settle -- 1.25   # pays 1.25 FXRP
```

Or run the whole HTTP rail - in one terminal:

```bash
npm run serve:x402       # facilitator + a $0.25 endpoint on :8402
```

and in another:

```bash
npm run agent            # gets a 402, pays it, gets the resource
```

Or hand the rail to an assistant instead of a script:

```bash
npm run mcp              # MCP server over stdio - see "An assistant that can spend"
```

It resolves FXRP through the registry, checks its locally built EIP-712 digest
against the facilitator's own `intentDigest()` before signing anything, and
refuses to run if the payer is short, the relayer has no gas, or the invoice was
already settled.

There is a recording script in [DEMO.md](DEMO.md) if you are filming this rather
than running it.

To put the facilitator on the public internet rather than on localhost, see
[DEPLOY.md](DEPLOY.md) - it covers hosting the service on Railway, the variables
it needs, and why the relayer key means replicas have to stay at one.

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
  abi.ts                 every ABI, and every revert said in a sentence
  eip712.ts              the two signatures a payment needs, and their domains
  fxrp.ts                registry -> AssetManagerFXRP -> fAsset(), never hardcoded
  ftso.ts                XRP/USD feed, and USD -> FXRP conversion
  x402.ts                the wire format: 402 body, X-PAYMENT, X-PAYMENT-RESPONSE
  facilitator.ts         verify() and settle() against the chain
  middleware.ts          requirePayment() - charge for an Express route
  pay.ts                 the client side: quote, check, sign, pay
scripts/
  probe.ts               read-only: resolve FXRP, verify the signing domain
  price.ts               read-only: what is $X in FXRP right now?
  setup-wallets.mjs      generates a fresh payer, writes .env
  fund-payer.ts          moves FXRP to the payer, keeps its C2FLR at zero
  settle.ts              signs and settles one invoice, gaslessly
  serve-x402.ts          the facilitator service + a paid endpoint
  agent.ts               an agent that pays a 402 holding no gas token
  mcp.ts                 MCP server - an assistant that can spend, with caps
  settle-fork-test.mjs   settles a real invoice against a fork of live Coston2
  serve-web.mjs          local server matching production URL rules
web/
  index.html             landing page
  how-it-works.html      the flow, and why it takes two signatures
  contract.html          the facilitator, annotated
  status.html            what runs, what does not, and the receipts
  docs.html              reference
  app.js                 site menu
  styles.css             design system
vercel.json              static hosting, no build step
railway.json             hosting for the facilitator service - see DEPLOY.md
```

---

## What comes next

Each of these is a known piece of work with a known shape, in the order it would
be done.

**Concurrent payments from one payer.** EIP-2612 nonces are sequential, so an
agent paying two endpoints at once has the second permit fail on a consumed
nonce. EIP-3009's random nonces avoid this, and FXRP does not implement
EIP-3009, so payments are serialised per payer today. The MCP server pays for one
resource at a time for the same reason - paying for two means solving this, not
calling `pay` twice.

**Namespace invoice IDs per payer, in the contract.** `settled` is keyed on
`invoiceId` alone, and invoice IDs travel the x402 HTTP path, so anyone who sees
one can spend it first. The service already recovers from that: a payment against
a spent invoice is answered with a fresh quote, and the client signs the new one
and carries on. No funds were ever at risk either way, since the intent binds
payer, payee and amount. Keying on `(invoiceId, payer)` closes it at the source,
and costs nothing but a mapping key and a redeployment.

**Mainnet FXRP.** Everything here is Coston2. The signing path is unchanged on
mainnet, but the facilitator would need redeploying and auditing against the real
asset.

---

## License

MIT
