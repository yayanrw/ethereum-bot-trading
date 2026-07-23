import ccxt from 'ccxt';
import type { Config } from '../config.ts';
import type { Candle } from './indicators.ts';

export type OrderState = 'open' | 'closed' | 'canceled';

export interface OrderStatus {
  id: string;
  state: OrderState;
  /** Base-currency amount filled so far. */
  filled: number;
  /** Average fill price; falls back to the limit price when nothing filled yet. */
  average: number;
}

export interface Exchange {
  init(): Promise<void>;
  fetchClosedCandles(limit: number): Promise<Candle[]>;
  fetchPrice(): Promise<number>;
  createLimitBuy(qty: number, price: number): Promise<string>;
  createLimitSell(qty: number, price: number): Promise<string>;
  fetchOrderStatus(id: string): Promise<OrderStatus>;
  cancelOrder(id: string): Promise<void>;
  /** Round an amount to the market's precision/step size. */
  amountFor(usdt: number, price: number): number;
  priceFor(price: number): number;
  /** Exchange minimum order value in quote currency (0 if unknown). */
  minCostUsdt(): number;
  /** Dry-run only: advance simulated time so resting orders can fill. No-op live. */
  markPrice(price: number): void;
}

// --- shared ccxt client -------------------------------------------------------

function makeClient(cfg: Config) {
  const client = new ccxt.binance({
    apiKey: cfg.exchange.apiKey,
    secret: cfg.exchange.secret,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
  if (cfg.testnet) client.setSandboxMode(true);
  return client;
}

/**
 * ccxt returns the currently-forming candle as the last OHLCV row. Its close and
 * volume change on every poll, which would make indicator-based rules fire and
 * un-fire within the same hour — so it is dropped before anything sees it.
 */
function dropForming(rows: unknown[]): Candle[] {
  return rows.slice(0, -1) as Candle[];
}

/**
 * An order we cannot address later is worse than one we never placed: it would
 * rest on the book with no way to reconcile or cancel it.
 */
function requireOrderId(id: string | undefined, side: string): string {
  if (!id) throw new Error(`Exchange accepted a ${side} order but returned no order id`);
  return id;
}

// --- live / testnet -----------------------------------------------------------

class CcxtExchange implements Exchange {
  private client: ReturnType<typeof makeClient>;

  constructor(private cfg: Config) {
    this.client = makeClient(cfg);
  }

  async init(): Promise<void> {
    await this.client.loadMarkets();
  }

  async fetchClosedCandles(limit: number): Promise<Candle[]> {
    const rows = await this.client.fetchOHLCV(this.cfg.grid.symbol, this.cfg.timeframe, undefined, limit);
    return dropForming(rows);
  }

  async fetchPrice(): Promise<number> {
    const t = await this.client.fetchTicker(this.cfg.grid.symbol);
    const price = t.last ?? t.close;
    if (price === undefined) throw new Error('Ticker returned no last price');
    return price;
  }

  async createLimitBuy(qty: number, price: number): Promise<string> {
    const o = await this.client.createLimitBuyOrder(this.cfg.grid.symbol, qty, price);
    return requireOrderId(o.id, 'buy');
  }

  async createLimitSell(qty: number, price: number): Promise<string> {
    const o = await this.client.createLimitSellOrder(this.cfg.grid.symbol, qty, price);
    return requireOrderId(o.id, 'sell');
  }

  async fetchOrderStatus(id: string): Promise<OrderStatus> {
    const o = await this.client.fetchOrder(id, this.cfg.grid.symbol);
    const state: OrderState =
      o.status === 'closed' ? 'closed' : o.status === 'canceled' ? 'canceled' : 'open';
    return {
      id,
      state,
      filled: o.filled ?? 0,
      average: o.average ?? o.price ?? 0,
    };
  }

  async cancelOrder(id: string): Promise<void> {
    try {
      await this.client.cancelOrder(id, this.cfg.grid.symbol);
    } catch (err) {
      // Already filled or already gone — the next reconcile will see the truth.
      if (err instanceof ccxt.OrderNotFound) return;
      throw err;
    }
  }

  amountFor(usdt: number, price: number): number {
    return Number(this.client.amountToPrecision(this.cfg.grid.symbol, usdt / price));
  }

  priceFor(price: number): number {
    return Number(this.client.priceToPrecision(this.cfg.grid.symbol, price));
  }

  minCostUsdt(): number {
    return this.client.markets[this.cfg.grid.symbol]?.limits?.cost?.min ?? 0;
  }

  markPrice(): void {
    /* live orders fill on their own */
  }
}

// --- dry run ------------------------------------------------------------------

interface SimOrder {
  id: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  state: OrderState;
  filled: number;
}

/**
 * Reads real market data but never sends an order. Resting orders are simulated
 * honestly: a buy fills only once the price actually trades at or below its
 * limit, a sell once price reaches or exceeds it. Instant-filling every order at
 * its limit price would make the grid look far more profitable than it is.
 */
class DryRunExchange implements Exchange {
  private readonly live: CcxtExchange;
  private readonly orders = new Map<string, SimOrder>();
  private seq = 0;

  constructor(private cfg: Config) {
    this.live = new CcxtExchange(cfg);
  }

  init() {
    return this.live.init();
  }
  fetchClosedCandles(limit: number) {
    return this.live.fetchClosedCandles(limit);
  }
  fetchPrice() {
    return this.live.fetchPrice();
  }
  amountFor(usdt: number, price: number) {
    return this.live.amountFor(usdt, price);
  }
  priceFor(price: number) {
    return this.live.priceFor(price);
  }
  minCostUsdt() {
    return this.live.minCostUsdt();
  }

  private place(side: 'buy' | 'sell', qty: number, price: number): string {
    const id = `dry-${side}-${++this.seq}`;
    this.orders.set(id, { id, side, qty, price, state: 'open', filled: 0 });
    console.log(`[dry-run] place ${side} ${qty} @ ${price} -> ${id}`);
    return id;
  }

  async createLimitBuy(qty: number, price: number): Promise<string> {
    return this.place('buy', qty, price);
  }

  async createLimitSell(qty: number, price: number): Promise<string> {
    return this.place('sell', qty, price);
  }

  async fetchOrderStatus(id: string): Promise<OrderStatus> {
    const o = this.orders.get(id);
    if (!o) return { id, state: 'canceled', filled: 0, average: 0 };
    return { id, state: o.state, filled: o.filled, average: o.price };
  }

  async cancelOrder(id: string): Promise<void> {
    const o = this.orders.get(id);
    if (o && o.state === 'open') {
      o.state = 'canceled';
      console.log(`[dry-run] cancel ${id}`);
    }
  }

  markPrice(price: number): void {
    for (const o of this.orders.values()) {
      if (o.state !== 'open') continue;
      const hit = o.side === 'buy' ? price <= o.price : price >= o.price;
      if (hit) {
        o.state = 'closed';
        o.filled = o.qty;
        console.log(`[dry-run] fill ${o.side} ${o.qty} @ ${o.price} (mark ${price})`);
      }
    }
  }
}

export function createExchange(cfg: Config): Exchange {
  return cfg.dryRun ? new DryRunExchange(cfg) : new CcxtExchange(cfg);
}
