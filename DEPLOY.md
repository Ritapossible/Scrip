# Hosting the Scrip backend on Railway

The backend is the x402 facilitator service - `scripts/serve-x402.ts`, started by
`npm start`. It holds the relayer key, talks to Coston2, prices invoices at the
FTSO rate, and settles payments. This is the part that has to be hosted:
everything else in the repo is either a static site or a script you run locally.

What is being deployed, and what is not:

| Piece | Where it runs |
|---|---|
| Facilitator service (`/supported`, `/verify`, `/settle`, `/api/haiku`, `/price`) | **Railway** - this document |
| Marketing / docs site (`web/`) | Vercel, static, no build step (`vercel.json`) |
| `ScripFacilitator.sol` | Already deployed on Coston2 at `0x43F672C0a915F59A2472a07D2108936e217cB04C` |
| `probe`, `price`, `settle`, `agent`, `test:fork` | Your machine |
| MCP server (`npm run mcp`) | Your machine - it speaks stdio to a local client and holds the payer key, so it is deliberately not hosted |

The contract is already on chain and does not get deployed again. Railway hosts
the HTTP service in front of it.

---

## Before you start

You need four things. Get them together first - two of them cannot be recovered
if you improvise them at the wrong moment.

1. **A funded relayer wallet on Coston2.** It pays gas for every settlement. Fund
   it from the [Coston2 faucet](https://faucet.flare.network/coston2). A few
   C2FLR settles hundreds of payments at ~200k gas each.
2. **That wallet's private key.** It goes into a Railway variable. Use a throwaway
   key generated for this and nothing else - never one that has touched mainnet,
   and never the payer's key.
3. **An invoice secret.** 32 random bytes:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Generate it now and keep it. Changing it later invalidates every quote in
   flight.
4. **A Railway account** with the GitHub repo connected.

A note on the relayer key that is easy to skip past: anyone who can reach
`POST /settle` can make your relayer pay gas for a payment to an arbitrary payee.
That is the contract's design - permissionless settlement is why the
`PaymentIntent` exists at all - and the service rate-limits the two endpoints
that cost gas, but the exposure is real. Fund the relayer with what you are
willing to have spent on a public demo, not with more.

---

## 1. Push the repo

Railway deploys from a GitHub branch. The repo is already at
`github.com/Ritapossible/Scrip`, so:

```bash
git push origin main
```

`.env` is gitignored and must stay that way. Every secret below goes into
Railway's variables, never into a committed file.

---

## 2. Create the service

In the Railway dashboard:

1. **New Project → Deploy from GitHub repo → `Ritapossible/Scrip`.**
2. Railway reads `railway.json` at the repo root and configures itself from it:

   ```json
   {
     "build": { "builder": "NIXPACKS" },
     "deploy": {
       "startCommand": "npm start",
       "healthcheckPath": "/health",
       "healthcheckTimeout": 300,
       "restartPolicyType": "ON_FAILURE",
       "restartPolicyMaxRetries": 3
     }
   }
   ```

   You do not need to fill in a build command or a start command in the UI. If
   the UI shows something different from the file, the file wins on the next
   deploy.

3. Leave the root directory as the repo root. There is no monorepo layout here.

Nixpacks sees `package.json`, installs dependencies, and runs `npm start`. There
is no build step - `tsx` runs the TypeScript directly.

**Do not move `tsx` into `devDependencies`.** It looks like a dev tool and it is
not: `npm start` is `tsx scripts/serve-x402.ts`, and Railway installs production
dependencies only. Moving it makes the container build cleanly and then fail at
boot with `tsx: not found`.

---

## 3. Set the variables

Railway → your service → **Variables**. These are the whole configuration.

| Variable | Value | Required |
|---|---|---|
| `RELAYER_PK` | `0x…` - the funded Coston2 wallet. Pays all gas. | **Yes** |
| `FACILITATOR_ADDRESS` | `0x43F672C0a915F59A2472a07D2108936e217cB04C` | **Yes** |
| `SCRIP_INVOICE_SECRET` | The 32 random bytes from step 3 above | **Yes** |
| `TRUST_PROXY` | `1` | **Yes, on Railway** |
| `RPC_URL` | `https://coston2-api.flare.network/ext/C/rpc` | Optional, this is the default |
| `PAYEE_ADDRESS` | `0x…` where payments land. Defaults to the relayer. | Optional |
| `PORT` | Leave unset. | Optional |

Four of these have consequences worth stating plainly.

**`RELAYER_PK` is a spending key.** Railway variables are not encrypted secrets in
any strong sense - anyone with access to the project can read them back. Treat
project access as key access.

**`SCRIP_INVOICE_SECRET` is not optional in a deployment that restarts, which is
every deployment.** Invoice ids are an HMAC over (resource, amount, deadline)
keyed by this secret - that is what lets the service prove it issued a quote
without storing anything. Without the variable the service generates a random key
per process and warns at startup:

```
warning: SCRIP_INVOICE_SECRET is not set. Using a per-process random key,
so quotes issued before a restart will be rejected after it.
```

A client that was midway through paying when Railway restarted the container gets
a rejection it cannot explain. Set it.

It is an HMAC key and nothing else. It signs no transaction and derives no
address, so do **not** reuse the relayer's private key here - that would spread a
funded key into a second variable for no benefit.

**`TRUST_PROXY=1` matters on Railway specifically.** Behind Railway's proxy,
`req.ip` is the proxy's address unless Express is told to trust one hop. Without
this, every caller lands in the same rate-limit bucket and one client can lock
out everyone else. It is `1` and not `true` on purpose: a permissive value lets a
client put whatever it likes in `X-Forwarded-For` and walk around the limiter
entirely. Leave it unset when running locally, where nothing sets the header.

**Leave `PORT` alone.** Railway injects it, and the service already reads
`process.env.PORT` and binds `0.0.0.0` rather than loopback - a container bound to
`127.0.0.1` is unreachable from outside itself and the health check sees a dead
service. If you do set `PORT` explicitly, the generated domain's target port must
match it, or Railway routes to a port nothing is listening on.

---

## 4. Generate a domain

Railway → **Settings → Networking → Generate Domain**. You get something like
`scrip-production.up.railway.app`.

Railway exposes that hostname to the process as `RAILWAY_PUBLIC_DOMAIN`, and the
service prints it at boot instead of a localhost URL it does not actually have.
Nothing else depends on it - it is honesty in the logs, not configuration.

---

## 5. Watch the first boot

Deploy logs. A healthy start looks like this:

```
Scrip x402 facilitator - flare-coston2

  listening       https://scrip-production.up.railway.app
  facilitator     0x43F672C0a915F59A2472a07D2108936e217cB04C
  relayer         0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
  payee           0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
  scheme          exact-permit2612

  paid resource   GET /api/haiku   ($0.25)
  facilitator     GET /supported, POST /verify, POST /settle

  pay it with:    npm run agent

  checking the facilitator is bound to the current FXRP...
  asset           0x0b6A3645c240605887a5532109323A3E12273dc7 (FTestXRP, 6 decimals)

  ready
```

**The port opens before any of that chain work happens**, and that ordering is
deliberate. The service still resolves FXRP through the registry and checks that
the facilitator contract is bound to that same token - the facilitator's `token`
is immutable, so one bound to a stale FXRP can never be fixed, only redeployed,
and finding that out at startup beats finding it out inside a revert during a
demo. But the check now runs *after* the service is listening, because a health
check can only observe whether the port answers. A process that spends a minute
on a cold RPC before binding, and a process that died on a missing variable, look
identical from outside: both report "healthcheck failure" and neither says which
one happened.

So `GET /health` reports which state it is in:

| `status` | HTTP | Meaning |
|---|---|---|
| `checking` | 200 | Listening; the FXRP binding check has not finished. Normal for the first few seconds. |
| `ready` | 200 | Bound to the current FXRP. Everything works. |
| `broken` | 503 | The binding check failed. Waiting will not fix it; the `error` field says why. |
| `misconfigured` | 503 | A variable is missing or unparseable. The `error` field names it. |

A missing `RELAYER_PK` no longer kills the process. The service starts anyway and
serves the reason on every endpoint, so a failed deploy can be diagnosed by
curling it rather than by reading scrollback:

```bash
curl -s https://scrip-production.up.railway.app/health
# {"ok":false,"status":"misconfigured",
#  "error":"RELAYER_PK is not set. ... set RELAYER_PK in the service's
#           environment variables - see DEPLOY.md."}
```

---

## 6. Verify it from outside

From your own machine, not from Railway's shell:

```bash
BASE=https://scrip-production.up.railway.app

curl -s $BASE/health
# {"ok":true,"facilitator":"0x43F6...","relayer":"0xaA34..."}

curl -s $BASE/supported
# {"x402Version":1,"kinds":[{"scheme":"exact-permit2612","network":"flare-coston2"}], ...}

curl -s $BASE/price
# the live XRP/USD feed this service bills against

curl -si $BASE/api/haiku | head -1
# HTTP/2 402
```

That 402 is the real test. It means the service reached the FTSO feed, priced
$0.25 in FXRP at the live rate, and issued a signed invoice id. Read the body:

```bash
curl -s $BASE/api/haiku | python -m json.tool
```

`accepts[0]` should carry `maxAmountRequired`, the `rate` it was derived from, the
`invoiceId`, and a `deadline` ten minutes out.

Check the rejection path too - a client speaking the USDC dialect of x402 should
be turned away with a sentence rather than a revert:

```bash
curl -s -X POST $BASE/verify \
  -H 'content-type: application/json' \
  -d '{"x402Version":1,"scheme":"exact"}'
```

The `content-type` header is load-bearing. Without it `express.json()` skips the
body and you get a complaint about a missing `x402Version` instead of the
scheme explanation.

---

## 7. Pay it, from anywhere

The agent takes a URL, so nothing about it is local:

```bash
npm run agent -- https://scrip-production.up.railway.app/api/haiku
```

It fetches the 402, recomputes the FXRP amount from the rate the server showed
its working for, checks its intent digest against the facilitator's own, signs
twice, and retries with `X-PAYMENT`. The payer's C2FLR balance is zero before and
after. That last line of output is the demo:

```
  PASS  the agent paid for an API call holding no gas token at all
```

If this works against the Railway URL, the rail is hosted and public.

---

## Operating it

**Keep replicas at 1.** Railway will happily scale a service horizontally and it
would break this one. Every replica would share the relayer key, and two replicas
submitting transactions from the same address race on that account's nonce -
one of the two gets replaced or dropped, and a payment that verified fine
disappears. Nothing in the service coordinates this. One replica.

**Watch the relayer balance.** Each settlement costs roughly 200k gas, paid by
the relayer, forever. Nothing in the service tops it up or warns you. When it
empties, `/settle` starts failing and the message will be about funds rather than
about payments. `GET /health` reports the relayer address - check it on the
explorer periodically.

**The rate limit is 12 requests per minute** on `/verify` and `/settle`, the two
endpoints that cost gas. `/health`, `/supported`, `/price` and `/api/haiku` are
open, because those are what a reader actually hits and an unpaid `/api/haiku`
only reads a price feed. A rate-limited caller gets a 429 with an x402-shaped
body explaining what happened. Tune it in `scripts/serve-x402.ts` if a judge
hammering the demo trips it.

**Restarts are capped at 3.** `restartPolicyMaxRetries: 3` means a service that
crashes on boot - bad key, stale facilitator, unreachable RPC - stops instead of
crash-looping. It will sit there dead. That is intentional, but it means "the
site is down" and "the deploy failed four hours ago" look identical from outside.
Check the deploy status, not just the URL.

---

## When it does not work

**Healthcheck failure is a symptom, not a cause.** Railway reports it whenever
the port does not answer in time, whatever the underlying reason. Ask the service
first - `curl https://<domain>/health` - because in every case except a crashed
container it will name the problem itself.

| Symptom | Cause | Fix |
|---|---|---|
| Healthcheck failure, `/health` says `misconfigured` | A required variable is missing or is literally `0x`. The `error` field names it. | Set it in Railway variables and redeploy |
| Healthcheck failure, nothing served at all | The container is not running - build failure, or a crash before startup | Read the deploy logs; the build step usually says so |
| `/health` says `broken`: `facilitator is bound to 0x… but the registry resolves FXRP to 0x…` | FAsset was redeployed on Coston2; the facilitator's `token` is immutable | Redeploy `ScripFacilitator.sol` against the current token, update `FACILITATOR_ADDRESS` |
| `/health` stuck on `checking` for minutes | The public Coston2 RPC is cold or unreachable from the container | Usually resolves itself; a dedicated RPC endpoint fixes it permanently |
| `tsx: not found` | `tsx` was moved to `devDependencies` | Move it back to `dependencies` |
| Health check fails, logs stop after the boot banner | Service bound to loopback, or `PORT` set to something the domain does not target | Leave `PORT` unset; the code already binds `0.0.0.0` |
| Deploy crashed and never came back | Hit `restartPolicyMaxRetries: 3` | Fix the cause, then redeploy manually |
| `/api/haiku` 500s with an FTSO message | `FTSO feed is …s old` - the feed stalled, and billing against a stalled feed is worse than refusing to bill | Wait; it is a Coston2 condition, not a bug |
| Everything 429s | One client is filling the shared rate-limit bucket | Confirm `TRUST_PROXY=1` is set - without it every caller shares one bucket |
| Timeouts on first request after idle | Cold public Coston2 RPC. The transport already allows 45s with retries | Retry; consider a dedicated RPC endpoint if it persists |
| Quotes rejected right after a deploy | `SCRIP_INVOICE_SECRET` unset, so the restart rotated the key | Set it |

To read the live logs from your terminal instead of the dashboard:

```bash
npm i -g @railway/cli
railway login
railway link          # pick the project
railway logs
```

---

## Redeploying

Railway redeploys on every push to `main`. To ship a change:

```bash
git push origin main
```

Changing a variable also triggers a redeploy. Rolling back is a redeploy of an
earlier commit from the Railway deployments list - and note that rolling back
does not roll back variables, so a rollback across a variable change leaves you
in a state that never existed in CI.

---

## Cost

The service is one small always-on container: a Node process, no database, no
volume, no build step. It idles at near-nothing and Railway bills by usage on the
Hobby plan's monthly credit. The cost that is easy to forget is not Railway's -
it is the C2FLR the relayer spends on gas, which is testnet money now and would be
real money on mainnet.
