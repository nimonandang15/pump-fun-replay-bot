// Flash-scalp bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, from the dev window's own tape (24h, 1222 launches): a launch's whole
// life is decided in its first seconds. The median coin peaks 7 slots after its
// CreateEvent and the median price 5 slots in is already +17% over create, while
// the median coin is back near its create price 200 slots later. Chasing mature
// momentum (the house pilot does that) buys the top and rides it to zero. This
// bot does the opposite: it only ever buys young coins, scores each launch's
// opening tape, takes one small shot per coin, and exits fast — a partial
// take-profit, a full take-profit, a tight stop, a trailing stop once the trade
// works, and a hard time limit. No coin is ever bought twice and no loser is
// ever averaged down.
//
// Scoring (0-100) weighs breadth over size: many distinct buyers, real net SOL
// flowing in, a run-up that is hot but not vertical, the creator with skin in
// the game but not selling, and no single wallet dominating the buys. The stake
// scales with the score so the best-looking launches get the most size.
//
// Exits, checked every batch against the curve's latest reserves:
//   * partial take-profit at +15% (sell half, bank it),
//   * full take-profit at +35%,
//   * stop loss at -10% of cost,
//   * trailing stop: once the position peaked +20% over cost, sell on a 12%
//     fall from that peak,
//   * creator sells while we hold -> sell at once,
//   * any single recorded sell of >= 1 SOL -> sell at once,
//   * no trade for 600 slots -> sell (dead coin, free the slot),
//   * held longer than maxHold slots -> sell.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only
// over insertion-ordered maps fed by the batch stream. All money math is bigint
// lamports; the float SOL values are only for the score and the sizing, never
// for the exit decisions (those compare bigint value against bigint cost).

import type { Batch, Bot, BotState, Done, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  entryMaxAge: number;
  /** Distinct non-creator buyers the opening tape must show. */
  minBuyers: number;
  /** Trades the opening tape must show. */
  minTrades: number;
  /** Net buy SOL (buys minus sells) the opening tape must show. */
  minNetSol: number;
  /** Price now over the create price, in bps: entry window. */
  minRunUpBps: number;
  maxRunUpBps: number;
  /** Largest single non-creator buyer's share of buy SOL, in bps, at most. */
  maxTopShareBps: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Entry score (0-100) at or above which the bot buys. */
  scoreThreshold: number;
  /** Smallest stake (SOL) for a bare-pass score; scales up with the score. */
  baseStakeSol: number;
  /** Largest stake (SOL) for a perfect score. */
  maxStakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Slippage allowed on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** First take-profit: sell tp1PartBps of the position at this much over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: arms once the value is this far over cost, then exits on a fall of trailBps from the peak value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most positions open at once (the harness cap is 5). */
  maxPositions: number;
  /** Pyramid into strength: keep buying a winner in steps while it rises. */
  pyramid: boolean;
  /** SOL per add-on buy. */
  addSol: number;
  /** An add needs the price at least this far (bps) above the last buy's price. */
  addStepBps: number;
  /** An add needs the position's value at least this far (bps) over its cost. */
  addIfUpBps: number;
  /** An add needs net SOL inflow since the last buy of at least this. */
  addNetSol: number;
  /** Most SOL invested in one position in total. */
  maxInvestedSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
}

// The settings main.ts trades with. Chosen on the dev window with a local sweep
// (tools live outside this repo), preferring a flat region over the single best
// cell: neighbours within +/-1 step on every knob score +0.09..+0.12 SOL, both
// halves of the window are positive (+0.096 / +0.022), and the max drawdown is
// 0.002. The two ideas that matter are (1) buy BEFORE the run-up (max +20% over
// create: buying the pump after it prints loses) and (2) pyramid into strength
// from a breakeven position (addIfUpBps 0), so winners get size and losers stay
// tiny probes. Single best cell is not trusted on its own: see STRATEGY.md.
export const DEFAULT_PARAMS: Params = {
  entryMaxAge: 25,
  minBuyers: 6,
  minTrades: 4,
  minNetSol: 0.5,
  minRunUpBps: 0,
  maxRunUpBps: 2000,
  maxTopShareBps: 6000,
  minRealSol: 2,
  maxRealSol: 80,
  scoreThreshold: 60,
  baseStakeSol: 0.05,
  maxStakeSol: 0.2,
  minBuySol: 0.02,
  buySlipBps: 10000,
  sellSlipBps: 10000,
  tp1Bps: 1500,
  tp1PartBps: 5000,
  tpBps: 3500,
  slBps: 1000,
  trailArmBps: 2000,
  trailBps: 1200,
  maxHold: 60,
  exitOnDevSell: true,
  bigSellSol: 1.0,
  staleSlots: 600,
  maxPositions: 5,
  pyramid: true,
  addSol: 0.1,
  addStepBps: 0,
  addIfUpBps: 0,
  addNetSol: 0.2,
  maxInvestedSol: 0.5,
  maxAdds: 6,
};

const LAMPORTS = 1_000_000_000n;
const BPS = 10_000n;
/** Curve fee on every trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after curve fees (tx fee extra). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

interface Coin {
  createSlot: number;
  creator: Pubkey;
  /** Create-time price as a vq/vt pair (run-up is measured against it). */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buys: number;
  sells: number;
  buyers: Set<Pubkey>;
  /** SOL bought by each non-creator wallet (lamports). */
  buyByUser: Map<Pubkey, bigint>;
  bought: bigint;
  sold: bigint;
  devBuy: bigint;
  devSold: boolean;
  bigSell: boolean;
  lastTradeSlot: number;
  /** A buy was sent for this coin (one shot per coin, win or lose). */
  entered: boolean;
}

interface Held {
  openedSlot: number;
  peakValue: bigint;
  tookTp1: boolean;
  /** Lamports spent on buys for this position (fees included, at decision). */
  invested: bigint;
  /** Decision price (vq/vt) of the last buy sent. */
  lastAddPrice: number;
  /** Net bought-minus-sold lamports when the last buy was sent. */
  lastAddNet: bigint;
  adds: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  let buysSent = 0;
  let sellsSent = 0;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createSlot: -1,
        creator: '',
        vq0: 0n,
        vt0: 0n,
        trades: 0,
        buys: 0,
        sells: 0,
        buyers: new Set(),
        buyByUser: new Map(),
        bought: 0n,
        sold: 0n,
        devBuy: 0n,
        devSold: false,
        bigSell: false,
        lastTradeSlot: -1,
        entered: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Opening-tape score 0-100, or -1 when a hard gate fails. */
  const score = (c: Coin, now: number, rqSol: number, priceNow: number, price0: number): number => {
    if (c.createSlot < 0 || now - c.createSlot > p.entryMaxAge) return -1;
    if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) return -1;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return -1;
    if (c.devSold) return -1;
    const netSol = Number(c.bought - c.sold) / 1e9;
    if (netSol < p.minNetSol) return -1;
    if (price0 <= 0) return -1;
    const runUpBps = Math.floor(((priceNow - price0) / price0) * 10000);
    if (runUpBps < p.minRunUpBps || runUpBps > p.maxRunUpBps) return -1;
    let top = 0n;
    for (const v of c.buyByUser.values()) if (v > top) top = v;
    if (c.bought > 0n && (top * BPS) / c.bought > BigInt(p.maxTopShareBps)) return -1;

    let s = 0;
    s += Math.min(30, c.buyers.size * 6);
    s += Math.min(25, Math.floor(netSol * 4));
    s += runUpBps <= 4000 ? 15 : 8;
    if (Number(c.devBuy) / 1e9 >= 0.05) s += 10;
    const topShare = c.bought > 0n ? Number((top * BPS) / c.bought) : 10000;
    s += topShare < 4000 ? 10 : 5;
    const dominance = c.buys + c.sells > 0 ? c.buys / (c.buys + c.sells) : 0;
    s += dominance >= 0.8 ? 10 : dominance >= 0.65 ? 5 : 0;
    return s;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      /** Coins whose tape moved this batch: the only ones whose score can change. */
      const touched = new Set<Pubkey>();
      /** Mints with an order already in flight this batch's decision. */
      const pendingByMint = new Map<Pubkey, 'buy' | 'sell'>();
      for (const po of state.pending.values()) {
        if (!pendingByMint.has(po.order.mint)) pendingByMint.set(po.order.mint, po.order.side);
      }

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
          touched.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          c.trades++;
          c.lastTradeSlot = e.slot;
          if (e.is_buy) {
            c.buys++;
            c.bought += sol;
            if (e.user === c.creator) {
              c.devBuy += sol;
            } else {
              c.buyers.add(e.user);
              c.buyByUser.set(e.user, (c.buyByUser.get(e.user) ?? 0n) + sol);
            }
          } else {
            c.sells++;
            c.sold += sol;
            if (e.user === c.creator) c.devSold = true;
            if (Number(sol) / 1e9 >= p.bigSellSol) c.bigSell = true;
          }
          touched.add(e.mint);
        }
      }

      // ---- Exits first: never leave a loser open while opening a new trade. ----
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          // Closed by the harness (completed/flattened) or by our own sell landing.
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            coinOf(mint).entered = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.get(mint) === 'sell') continue;
        const tokens = pos.token_amount;
        const cost = pos.cost_lamports;
        const value = sellValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
        if (value > h.peakValue) h.peakValue = value;
        const c = coinOf(mint);
        const upBps = cost > 0n ? Number(((value - cost) * BPS) / cost) : 0;
        let exitAll = false;
        let exitHalf = false;
        if (upBps <= -p.slBps) exitAll = true;
        else if (upBps >= p.tpBps) exitAll = true;
        else if (h.peakValue >= (cost * (BPS + BigInt(p.trailArmBps))) / BPS && value <= (h.peakValue * (BPS - BigInt(p.trailBps))) / BPS) exitAll = true;
        else if (p.exitOnDevSell && c.devSold) exitAll = true;
        else if (c.bigSell) exitAll = true;
        else if (now - c.lastTradeSlot > p.staleSlots) exitAll = true;
        else if (now - h.openedSlot > p.maxHold) exitAll = true;
        else if (!h.tookTp1 && upBps >= p.tp1Bps) exitHalf = true;
        if (!exitAll && !exitHalf) continue;
        if (orders.length >= cap) break;
        if (exitAll) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: p.sellSlipBps });
          sellsSent++;
          pendingByMint.set(mint, 'sell');
        } else {
          const half = tokens / 2n;
          if (half <= 0n) {
            orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: p.sellSlipBps });
          } else {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: p.sellSlipBps });
          }
          h.tookTp1 = true;
          sellsSent++;
          pendingByMint.set(mint, 'sell');
        }
      }

      // ---- Entries: one scored shot per young coin. ----
      let free = state.freeCashLamports();
      let slotsLeft = p.maxPositions - state.committedPositionCount();

      // Pyramid first: add to winners while they rise and money keeps flowing in.
      // Each add is still capped at 1% of the (now larger) real reserve, so size
      // grows with the coin instead of being stuck at the tiny first-buy cap.
      if (p.pyramid) {
        for (const [mint, h] of held) {
          if (orders.length >= cap) break;
          const pos = state.positions.get(mint);
          const curve = state.curves.get(mint);
          if (pos === undefined || curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint)) continue;
          if (h.adds >= p.maxAdds || h.invested >= BigInt(Math.floor(p.maxInvestedSol * 1e9))) continue;
          const tokens = pos.token_amount;
          const cost = pos.cost_lamports;
          const value = sellValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
          if (value < (cost * (BPS + BigInt(p.addIfUpBps))) / BPS) continue;
          const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          if (priceNow < h.lastAddPrice * (1 + p.addStepBps / 10000)) continue;
          const c = coins.get(mint);
          if (c === undefined) continue;
          if (Number(c.bought - c.sold - h.lastAddNet) / 1e9 < p.addNetSol) continue;
          let amount = BigInt(Math.floor(p.addSol * 1e9));
          const capLamports = state.maxBuyLamports(mint);
          if (amount > capLamports) amount = capLamports;
          if (amount > free - txFee) amount = free - txFee;
          if (amount < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          buysSent++;
          free -= amount + txFee;
          h.invested += amount;
          h.lastAddPrice = priceNow;
          h.lastAddNet = c.bought - c.sold;
          h.adds++;
          pendingByMint.set(mint, 'buy');
        }
      }

      for (const mint of touched) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.entered) continue;
        const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const price0 = c.vt0 > 0n ? Number(c.vq0) / Number(c.vt0) : 0;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        const s = score(c, now, rqSol, priceNow, price0);
        if (s < p.scoreThreshold) continue;
        const frac = (s - p.scoreThreshold) / (100 - p.scoreThreshold);
        const stakeSol = p.baseStakeSol + frac * (p.maxStakeSol - p.baseStakeSol);
        const capLamports = state.maxBuyLamports(mint);
        let amount = BigInt(Math.floor(stakeSol * 1e9));
        if (amount > capLamports) amount = capLamports;
        if (amount > free - txFee) amount = free - txFee;
        if (amount < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        buysSent++;
        free -= amount + txFee;
        slotsLeft--;
        c.entered = true;
        held.set(mint, {
          openedSlot: now,
          peakValue: 0n,
          tookTp1: false,
          invested: amount,
          lastAddPrice: priceNow,
          lastAddNet: c.bought - c.sold,
          adds: 0,
        });
        pendingByMint.set(mint, 'buy');
      }
      return orders;
    },

    onDone(state: BotState, done: Done): void {
      const cash = Number(state.cash) / 1e9;
      console.error(`flash-scalp done: cash ${cash.toFixed(6)} SOL, buys sent ${buysSent}, sells sent ${sellsSent}`);
    },
  };
}
