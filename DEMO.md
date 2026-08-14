# Demo script

A three-minute recording. The order is chosen so the strongest evidence lands
early: a stranger can see a live FTSO-priced invoice inside the first minute,
and a real settlement from a wallet holding no gas token inside the second.

Read the narration as prompts rather than lines to recite. What matters is that
every claim on screen is one the terminal has just proved.

---

## Before you press record

**Never put `.env` on screen.** Not to open it, not to `cat` it, not in a file
tree, not in an editor tab. It holds two private keys. If you need a variable
during the recording, have it already exported in the shell.

Then:

```bash
# 1. Wake the hosted service. The first call after idle can be slow while the
#    public Coston2 RPC warms up, and you do not want that pause on camera.
curl -s https://scrip-production.up.railway.app/health

# 2. Confirm it is ready, not just listening. You want "status":"ready".
#    "checking" means give it a few more seconds.

# 3. Confirm the payer can still pay. It needs FXRP and exactly zero C2FLR.
npm run price
```

- **Terminal:** at least 16pt, dark background, window wide enough that
  `npm run agent` output does not wrap. Wrapped output ruins the last line,
  which is the one that matters.
- **Takes:** each full payment costs about 0.248 FXRP. The payer holds 3.92, so
  roughly **15 runs**. If you run low: `npm run fund -- 2` moves more from the
  relayer.
- **Rate limit:** the facilitator allows 12 settlement attempts a minute. Normal
  recording never touches it; hammering it in retakes might.
- **Payee allowlist:** the hosted facilitator only spends gas for
  `0xaA34e1…D02Bd`. Filming against `/api/haiku` is unaffected, because that is
  the payee it quotes. Point the agent at a resource that names a different payee
  and it will be refused - correctly, but not on camera.
- **MCP:** if you are filming that section, have your assistant client already
  connected and the tool list visible once, so the viewer sees the tools exist.

---

## 0:00 - 0:20 · What the problem is

**On screen:** the site, [scrip-pay.vercel.app](https://scrip-pay.vercel.app)

> Software that pays for things has to hold a gas token, keep topping it up, and
> manage a key that can send transactions. None of that is what the software was
> built to do.
>
> Scrip is a payment rail where the agent holds none of it. It pays in FXRP -
> bridged XRP on Flare - priced in dollars, and it never sends a transaction.

Keep this short. The terminal is the proof; the site is just the frame.

---

## 0:20 - 0:55 · A price, quoted live

**On screen:** terminal

```bash
curl -i https://scrip-production.up.railway.app/api/haiku
```

> This is a hosted x402 facilitator - a public URL, not something running on my
> laptop. I ask for a paid endpoint without paying, and it answers 402.
>
> The 402 carries the price: twenty-five cents, converted to FXRP at Flare's FTSO
> feed at the moment I asked. The rate is in the response, so the client can
> recompute the amount itself and refuse if the server's arithmetic disagrees
> with its own.

Point at `priceUsd`, `maxAmountRequired`, and `rate` as you say it. Mention the
`invoiceId` is single use and the quote expires in ten minutes.

---

## 0:55 - 1:50 · Paying it, holding no gas

**On screen:** terminal

```bash
npm run agent -- https://scrip-production.up.railway.app/api/haiku
```

Let it run. It takes a few seconds. Narrate the checks as they appear:

> Before it signs anything it checks three things: that the asset in the invoice
> is the FXRP the chain's own registry resolves to, that the amount matches the
> rate the server published, and that the payment digest it built agrees with the
> facilitator contract's. A client that signs whatever a server puts in front of
> it is not a payment rail.

Then, on `signed two messages, sent no transaction`:

> Two signatures, both offchain. No transaction from this wallet.

Then stop on the last two lines and let them sit:

```
  payer C2FLR        0 -> 0

  PASS  the agent paid for an API call holding no gas token at all
```

> The relayer paid the gas. The payer's native balance was zero before and zero
> after - and that is checked, not claimed. A wallet that has ever received gas
> can't pass this test, because you cannot drain an account to exactly zero.

**This is the shot.** Do not rush off it. Everything else in the video supports
this frame.

---

## 1:50 - 2:30 · An assistant that can spend

**On screen:** your assistant client, tools visible

Ask it, in plain language:

> What does the haiku endpoint cost?

then

> Go ahead and pay for it.

> The same rail, inside a conversation. Four of the five tools can't spend
> anything - they price, quote, read the wallet, inspect a facilitator. Only one
> moves money.
>
> And it has two limits it cannot raise: a per-call ceiling and a session budget,
> both checked against the quoted dollar price before a signature exists. A tool
> argument can lower them for one call and never lift them. They are enforced on
> the client, because a cap the server sets is not a cap.

Show the receipt it returns - transaction hash, and `payer C2FLR 0 -> 0` again.

If you are short on time, this is the section to trim to twenty seconds. Do not
cut it entirely; it is the part nobody else will have.

---

## 2:30 - 2:50 · Why this is Flare and not a chain-agnostic demo

**On screen:** the how-it-works page, or stay in the terminal

> Three Flare-native pieces are load-bearing.
>
> FAssets is the settlement asset - this gives bridged XRP somewhere to be spent
> rather than held. FTSO prices every invoice, so the oracle is doing work rather
> than decorating a slide.
>
> And FXRP implements EIP-2612 permit, not the EIP-3009 that every x402
> implementation in the wild is written against. A permit authorises an
> allowance but says nothing about where the money goes, so this rail carries a
> second signature naming the invoice, the payee and the amount. That is why the
> scheme is called exact-permit2612 - a USDC-shaped client should find out from
> the name rather than from a revert.

This is the answer to "is the integration superficial?" Say it plainly.

---

## 2:50 - 3:00 · Close

**On screen:** the status page

> The facilitator is deployed and source-verified on Coston2, the service is
> public, and every claim on the status page has a transaction hash behind it.
> Repo is MIT, and the whole thing was built during the program.

---

## If something goes wrong mid-take

| What you see | What it means | What to do |
|---|---|---|
| `expected 402 … got 200` | Something already paid this invoice | Just re-run; each quote is fresh |
| `payer holds … invoice is …` | Payer is out of FXRP | `npm run fund -- 2`, then re-run |
| `FTSO feed is …s old` | Coston2's feed stalled | Wait a minute. Billing against a stale feed is refused on purpose |
| `rate limited` | More than 12 settlements in a minute | Wait sixty seconds |
| `payee … is not on this facilitator's allowlist` | The resource quotes a payee the hosted facilitator was not configured to serve | Expected against a third-party endpoint; use `/api/haiku` for the demo |
| A long pause before the 402 | Cold public RPC | Pre-warm with `/health` before recording |
| `status":"checking"` on health | Service is up, still verifying its FXRP binding | Wait a few seconds and curl again |

---

## What to put in the submission alongside it

- **Demo link:** <https://scrip-production.up.railway.app> - live, no install
- **Site:** <https://scrip-pay.vercel.app>
- **Repo:** <https://github.com/Ritapossible/Scrip>
- **A transaction:** [`0xe3cb0532`](https://coston2-explorer.flare.network/tx/0xe3cb0532e8824c8ab780ddcacb637ed1aa4ed19a6646764787a63ad6e47d9098) -
  an agent paying the hosted facilitator, gaslessly

Judges are time-constrained. If they watch one minute, make it 0:55 to 1:50.
