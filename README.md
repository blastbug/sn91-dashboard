# Cascade (SN91) Dashboard

A multi-page dashboard for Bittensor Subnet 91 (Cascade) — the round competition,
miner scores, and the audit trail behind them.

## Design

Dark violet console theme with a persistent sidebar (Overview / Rounds / Miners / Verification)
and a live topbar (subnet, block, tempo, round stage, local clock). The Overview dashboard uses
KPI cards with real historical sparklines (drawn from the 80-round history, not fabricated),
a ring-gauge verification panel, a performance chart with average/best/worst/std-dev quads, and
activity/validator-status panels — all backed by the same public receipt store and Taostats data
as the rest of the app. No panel shows invented numbers: widgets that would need local machine
telemetry (GPU/CPU, wallet balance, peer latency) were intentionally left out rather than faked,
since this is a passive dashboard over public chain and receipt data, not an agent running inside
a miner process.

## Setup

1. Copy `.env.example` to `.env` and paste in a [taostats.io/pro](https://taostats.io/pro) API key.
2. `npm install && npm start`
3. Open http://localhost:3000

The API key is only needed for the chain-side data (metagraph, registrations, stake flow).
Round, scoring and verification pages read the **public** Cascade receipt store and work
without any credentials.

## Deploying

This is a plain long-running Node server, not a static site — it needs a host that keeps a
process alive, not a serverless one. The in-memory cache and the Taostats rate-limit queue
(`src/cache.js`, `src/taostats.js`) both assume a single persistent process; Vercel and Netlify
run short-lived serverless functions instead, which would let concurrent requests bypass the
queue and start tripping Taostats' 429 limit again. **Render, Railway, or Fly.io** run
`server.js` as-is with no code changes.

**Render** (free tier, no CLI needed):
1. Push this repo to GitHub if it isn't already.
2. On [render.com](https://render.com), New → Blueprint, point it at the repo — it reads
   `render.yaml` and creates the service automatically.
3. When prompted, set `TAOSTATS_API_KEY` (the one field `render.yaml` deliberately leaves for
   you to fill in on the dashboard rather than committing to git).
4. Deploy. Render sets `PORT` itself; the app already reads `process.env.PORT`.

Railway and Fly.io work the same way without a blueprint file: connect the repo, set
`TAOSTATS_API_KEY` as an environment variable, and use `npm start` as the start command.

## Pages

Four pages. The Overview is deliberately minimal — the detail lives one click away.

| Page | What it holds |
|---|---|
| **Overview** | The essentials: what stage the round is in and how long is left, who holds the crown, whether the last challenge succeeded, what the top of the reign chain earns — and the verification status of every submitted miner (advanced / screened / rejected, with the reason). |
| **Rounds** | The round in flight first — stage pipeline, screening progress, validator verification, submitted generators — then the full history and reign chain. Each row opens a per-round detail view. |
| **Miners** | The leaderboard (chain position joined to last round's scores), the reward distribution by rank, and chain activity: registrations, stake flow, and the metagraph. |
| **Verification** | How a round is proven, every validator's published receipt, and why receipts get rejected. |

`/live`, `/rewards` and `/chain` were folded into these and now redirect, so old links keep working.

Every page except the Overview carries a live status rail with the round's stage and clock; the
Overview omits it because its lead panel already says the same thing.

## How the subnet works

Miners don't submit models — they submit **synthetic data generators**. The model is held
byte-identical for everyone, so the only variable is data quality.

Each ~12h round (3600 blocks) runs in two phases. In the **heat**, every committed generator
trains a short reduced-size run and is ranked by CRPS; only the top finishers advance. In the
**final**, those finalists and the reigning king each train the full model on their own corpus
and forecast the same held-out windows.

The result is decided king-of-the-hill: a challenger's advantage over the king is bootstrapped
across evaluation windows, and the crown only moves if the **lower confidence bound** of that
advantage clears a **win margin** that decays as the king's tenure grows. Emission is split down
the reign chain, so recently dethroned kings keep earning a decaying share.

**Cohort duels.** The duel is no longer one challenger against the incumbent. A cohort of `k`
finalists is scored against the king in the same round, each with its own LCB, and `cohort_alpha`
is the per-comparison significance level after correcting for testing k of them at once (0.05/k) —
so a larger field is a harder bar for every member of it. `chal_uid` on the receipt is whichever
finalist came out on top, not the only one that ran. The Overview's **Duel Cohort** board shows
every member's Δ against the king and its LCB against the margin.

**Warm starts.** Rounds resume from the previous champion's checkpoint rather than training cold;
`status/round.json` carries the `generation` counter and names both the checkpoint in use and the
one scheduled next.

**Duel-only rounds.** When the field is small enough the heat screen is skipped and every revealed
entrant is seated straight into the duel (`duel_only`, with `no_screen_reason` saying so). Rank is
then reveal order and CRPS / p(best) are genuinely unscored — not missing data.

**Consensus votes.** Rule changes are activated by stake-weighted validator signature. While a vote
is open, `status/chain.json` carries the tally; the Overview renders it against its threshold. Only
one of the validators publishing that document includes the tally, so the field blinks in and out
about once a minute — the server holds the last sighting for 30 minutes rather than letting the
panel flicker.

## Data sources

**Cascade receipts** — `https://s3.hippius.com/cascade-manifests/receipts/`. Validators publish
signed round receipts with public-read ACLs so third parties can audit rounds without credentials.
`index.json` lists every round; `<validator_hotkey>/round-<id>.json` is one validator's full receipt.

**Live status** — `status/round.json` is the trainer's stage document (`heat` → `duel` →
`validation`, with `heat_done`/`heat_total` inside the heat), and `status/heat.json` mirrors the
heat standings the moment they settle. Both are unsigned, single-writer and best-effort.

**These two stop.** They are a different publisher from `status/chain.json`, and they have gone
silent for days while the tournament carried on — on 2026-09-30 they were last written on
2026-09-24, describing epoch 9133200, by which point the chain had run 54 more rounds. A dashboard
that keys "the round in flight" off them simply freezes, with every panel showing a week-old round
and no indication anything is wrong. So the **chain mirror is the authority on which epoch we are
in**, and the stage document is trusted only while its `epoch_start_block` matches the chain's.
When it does not:

- the **stage is derived** from the epoch's position against the published `stage_windows`, or read
  as `published` once a receipt exists for that epoch;
- **per-miner heat figures** (rank, CRPS, MASE, p(best)) are reported as unavailable rather than
  carried over from the last round the document described;
- the **commit list on `status/chain.json`** — which never stops — drives the submission panels
  instead, so they show what is on chain this round rather than what was screened last week;
- `liveStatus()` returns a `feeds` block giving each document's `as_of`, age and whether it is
  current, and the Overview says in plain terms which feed stopped and what is still trustworthy.

The heat pointer keeps serving the **previous** round's standings until the current heat settles,
so it is only presented as this round's when its `epoch_start_block` matches the round in flight —
otherwise the dashboard labels it as history. Joining on nothing would show last round's ranking as
this round's result, which is the exact failure the subnet's own design note warns about.

Per-miner submission results therefore only exist for a round once its heat has settled: mid-heat
the Overview names the epoch its results actually came from. The heat document also truncates its
rejected list, so rejections are counted in full but only the published subset can be named.

Each receipt is ~4.4MB (1200 per-window scores per entrant), so the server aggregates it into a
~55KB summary — distribution histograms, head-to-head win rates, descriptive statistics — and
caches only that. The browser never downloads raw score arrays.

Every round is scored **independently by each validator**, so a round can be accepted by two and
rejected by a third. The dashboard keeps all of them rather than collapsing to one, and flags any
round where scored validators disagree.

**Taostats** — chain state for SN91, and the only metered dependency. The **free tier allows
5 calls/minute and 10,000 calls/month**; every chain call spends one credit, and a 429 with
`Insufficient credits` means the balance is empty (distinct from a rate limit, and never worth
retrying — the client fails fast and shows a banner naming the cause).

Cache lifetimes, not page refresh rate, govern spend: a reload inside a TTL is served from cache
for free. Defaults are budgeted at ~12 calls/hour (~8,640/month), inside the free allowance:
subnet every 10 min, metagraph every 20 min, chain events every 60 min. Tune via `TTL_*_MS` in
`.env` if you move to a paid plan. For scale: the original 25-30s TTLs cost ~360 calls/hour, which
burns the entire monthly free allowance in about 28 hours of a single open tab.

### Live updates

The free receipt store is streamed to the browser over server-sent events at `/api/stream`. The
server polls it once every `LIVE_INTERVAL_MS` (default 10s) and fans the result out to every open
connection, so the refresh window does not get more expensive as more tabs open it.

The snapshot is split into independently hashed sections — `chain`, `round`, `commits`, `board` —
and only the ones that actually changed are pushed. They move at wildly different rates: the block
height changes every 12s while the 230-row commit list is identical for an hour, so sending the
whole payload every tick meant ~98KB per client per interval to deliver a block number. Steady
state is now a few hundred bytes. A page subscribes to the sections it renders
(`/api/stream?parts=chain,round,board`), which is why only the miner roster pays for `commits`.

Clients merge frames into a local tree and repaint through a diffing `paint()`, so sections that
did not change keep their scroll position, text selection and hover state; ones that did flash
briefly. Block height is projected forward from the status document's own `as_of` timestamp, so the
counter keeps moving between publishes instead of freezing for a minute at a time.

If the stream cannot be established — a proxy that buffers the response answers the headers and
then sends nothing — a watchdog gives up after 12s and falls back to plain polling, and the topbar
indicator says which transport is in use. Chain-backed panels never ride the stream: they are
metered, so they stay on a 5-minute client-side refresh.

All outbound Taostats calls are serialized through one queue with a 12s gap (the free tier's 5/min ceiling),
and concurrent callers for the same resource share a single request. If a refresh fails, the last
good copy is served and the header shows a `◷ Cached` badge naming the affected sources.

Note: Taostats' generic `/extrinsic` and `/event` endpoints accept a `netuid` parameter but
**silently ignore it**, so chain events are read from the `subnet/neuron/registration`,
`subnet/neuron/deregistration` and `delegation` endpoints, which filter for real.

## Layout

```
server.js          routes + page serving
src/taostats.js    chain data (rate-limited queue)
src/cascade.js     round receipts (fetch + aggregate)
src/cache.js       stale-on-failure cache with in-flight dedup
public/js/         one module per page, common.js shared
```

Reward amounts come from the chain (`daily_reward` per uid), not from multiplying the weight
fraction, so the two can be compared as a check that a round's weights reached the chain intact.
α is priced in τ and USD from the most recent on-chain stake trade, which costs no extra API call.

Set `SUBNET_NETUID` in `.env` to point the chain pages at a different subnet.

**Metagraph gotcha:** the `stake` field on every neuron is always `0` on this subnet — dTAO moved
staked value to `total_alpha_stake` (root + alpha stake combined). Use `total_alpha_stake` for any
stake figure; `stake` alone will silently render as zero everywhere.
