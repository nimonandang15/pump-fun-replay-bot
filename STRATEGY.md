# Strategy: flash-scalp with scored entries

## What the dev window says

24 hours of pump.fun launches (1222 coins, 128,058 events). Two facts drive
everything:

1. **A launch's whole life is decided in its first seconds.** The median coin
   peaks 7 slots after its CreateEvent; the median price 5 slots in is already
   +17% over create, and the median coin is back near its create price 200
   slots later. Chasing mature momentum buys the top and rides it to zero —
   the house momentum pilot scores **-9.49 SOL** on this window.
2. **Only a few coins ever run.** 57% ever reach +20%, 25% reach +100%, 13%
   reach +200%. Most launches are losers; the money is in catching the few
   runners early and giving them size.

## The bot

- **One scored shot per coin, ever.** Each launch is watched from its
  CreateEvent. Its opening tape is scored 0–100 on breadth (distinct buyers),
  net SOL flowing in, a run-up that is hot but not vertical, the creator
  holding (not selling), and no single wallet dominating the buys. Score ≥ 60
  buys; the stake scales with the score.
- **Buy BEFORE the run-up.** Entries are only allowed while the price is at
  most +20% over create and the coin is at most 25 slots old. Buying after the
  pump prints is what loses money — widening the run-up cap to +80% turns the
  same bot from +0.12 SOL to about -0.95 SOL.
- **Pyramid into strength.** The first buy is tiny (the harness caps each
  batch's buys at 1% of a coin's real SOL reserve, so early buys are
  ~0.02–0.05 SOL). While the position is at breakeven or better and net SOL
  keeps flowing in, the bot adds up to 6 times, so winners grow to ~0.5 SOL
  invested and losers stay probes. This is the whole edge: count win rate is
  only ~19%, but size-weighted winners dominate.
- **Exit fast.** Partial take-profit at +15% (sell half), full take-profit at
  +35%, stop loss at -10%, trailing stop once +20% up, exit at once when the
  creator sells or a single ≥1 SOL sell lands, and a hard 60-slot hold limit.
  No loser is ever averaged down and no coin is ever bought twice.

## Dev-window result (official `grade-local`, process driver)

- **Net PnL +0.1168 SOL** (return +1.17%; at 2x fees still +0.0725 SOL)
- 80 fills over 36 coins, 36 round trips, win rate 19.4%
- Max drawdown 0.0019; guardrails met (36 coins ≥ 0.01 SOL round trips)
- 0 rejected orders, 1 failed tx; two executions reproduce byte for byte
- 90% bootstrap interval -0.038 .. +0.343 SOL

For comparison on the same window: house momentum pilot -9.49 SOL, house
reversion pilot -4.00 SOL, house sniper pilot -0.47 SOL.

## Honest caveats

- The profit leans on a few runners: the 3 best coins made 99% of the gains,
  and without them the dev net would be -0.04 SOL. That is structural to
  pump.fun (few coins run), not a bug, but it means a fresh window can lose.
- A 20-copy stress rebuild of the dev window has median -0.03 SOL (16 of 20
  copies lose): the resampled copies break the coherent pumps the pyramid
  rides, so the stress number understates a live window — but it is a fair
  warning that the dev score is not a forecast.
- Split-half check (real contiguous data, not resampled): first half +0.096
  SOL over 18 trips, second half +0.022 SOL over 17 trips — the edge shows up
  in both halves.
- Parameters were picked from a flat region of the sweep, not the single best
  cell: neighbours within one step on every knob score +0.09..+0.12 SOL.

## Files

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the strategy (all logic, all parameters).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
