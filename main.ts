// pump-fun-replay-bot: a flash-scalp bot for the Pump.fun Replay Sprint
// (agent-fun/replay/v2). The strategy lives in strategy.ts; the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The grader runs `node /bot/main.ts` (Node strips the types; no build step).
//
// Tuned defaults (see STRATEGY.md): score each launch's opening tape, buy
// young coins before the run-up (<= +20% over create, <= 25 slots old),
// pyramid into strength from breakeven, exit fast (TP +15%/+35%, SL -10%,
// 60-slot hold limit). Dev window: +0.117 SOL net PnL, 36 round trips,
// max drawdown 0.002, guardrails met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
