import type {
  Decision,
  GridConfig,
  IndicatorSnapshot,
  Lesson,
  LessonAction,
  LessonsFile,
  Lot,
  PendingBid,
  PositionsFile,
  RuleVerdict,
  TickPlan,
} from '../types.ts';

/** Grid levels, ascending, inclusive of both bounds where they land on the step. */
export function gridLevels(cfg: GridConfig): number[] {
  const levels: number[] = [];
  // Walk up from the lower bound; accumulate by index to avoid float drift.
  const count = Math.floor((cfg.upper - cfg.lower) / cfg.step);
  for (let i = 0; i <= count; i++) levels.push(round(cfg.lower + i * cfg.step));
  return levels;
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function compare(actual: number, op: string, expected: number): boolean {
  switch (op) {
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    case '==':
      return actual === expected;
    default:
      return false;
  }
}

/** A rule fires only when every one of its conditions holds. */
export function ruleMatches(snapshot: IndicatorSnapshot, rule: Lesson): boolean {
  if (rule.when.length === 0) return false; // an empty rule would block everything, forever
  return rule.when.every((c) => compare(snapshot[c.indicator], c.op, c.value));
}

/**
 * The lessons middleware. Every entry and every exit passes through here before
 * an order is touched; the first matching rule of the requested action wins.
 */
export function evaluateRules(
  snapshot: IndicatorSnapshot,
  lessons: LessonsFile,
  action: LessonAction,
): RuleVerdict {
  for (const rule of lessons.rules) {
    if (rule.action !== action) continue;
    if (ruleMatches(snapshot, rule)) {
      return { allowed: false, blockedBy: rule.id, rationale: rule.rationale };
    }
  }
  return { allowed: true };
}

/** The N nearest grid levels at or below `price` that hold no open lot. */
export function targetBidLevels(
  price: number,
  levels: number[],
  lots: Lot[],
  maxOpenBids: number,
): number[] {
  const taken = new Set(lots.map((l) => l.gridLevel));
  return levels
    .filter((l) => l <= price && !taken.has(l))
    .reverse()
    .slice(0, maxOpenBids);
}

/**
 * The grid level a lot should be sold at: the first level above both its grid
 * level and its actual entry price, so a bid that filled with upward slippage
 * still exits at a profit.
 */
export function sellTargetFor(lot: Lot, levels: number[]): number | undefined {
  const floor = Math.max(lot.gridLevel, lot.entryPrice);
  return levels.find((l) => l > floor);
}

export interface TickInput {
  snapshot: IndicatorSnapshot;
  positions: PositionsFile;
  lessons: LessonsFile;
  config: GridConfig;
  /** Injected so quantities respect exchange precision; defaults to plain division. */
  roundQty?: (usdt: number, price: number) => number;
  now?: () => string;
  id?: () => string;
}

/**
 * Pure. Decides what the tick should do; index.ts performs the side effects.
 * Everything testable about this bot lives here.
 */
export function decideTick(input: TickInput): TickPlan {
  const { snapshot, positions, lessons, config } = input;
  const roundQty = input.roundQty ?? ((usdt, price) => usdt / price);
  const now = input.now ?? (() => new Date().toISOString());
  const nextId = input.id ?? (() => crypto.randomUUID());

  const levels = gridLevels(config);
  const plan: TickPlan = {
    cancelBids: [],
    placeBids: [],
    cancelSells: [],
    placeSells: [],
    holdState: [],
    skipped: [],
    entryBlockedBy: undefined,
  };

  const decision = (
    type: Decision['type'],
    gridLevel: number,
    price: number,
    extra: Partial<Decision> = {},
  ): Decision => ({
    id: nextId(),
    type,
    at: now(),
    symbol: config.symbol,
    gridLevel,
    price,
    indicators: snapshot,
    ...extra,
  });

  // --- entry side ------------------------------------------------------------
  const wanted = targetBidLevels(snapshot.price, levels, positions.lots, config.maxOpenBids);
  const entry = evaluateRules(snapshot, lessons, 'block_entry');

  if (!entry.allowed) {
    // Pull every resting bid: a rule that says "don't enter here" is meaningless
    // if orders placed under the old rule are still sitting on the book.
    plan.cancelBids = [...positions.bids];
    plan.entryBlockedBy = entry.blockedBy;
    // Log once per distinct block, not once per tick — at a 60s poll the second
    // form would bury the evaluator's real signal under thousands of duplicates.
    if (positions.entryBlockedBy !== entry.blockedBy && wanted.length > 0) {
      plan.skipped.push(
        decision('entry_blocked', wanted[0]!, snapshot.price, { blockedBy: entry.blockedBy }),
      );
    }
  } else {
    const wantedSet = new Set(wanted);
    plan.cancelBids = positions.bids.filter((b) => !wantedSet.has(b.gridLevel));
    const resting = new Set(positions.bids.map((b) => b.gridLevel));
    for (const level of wanted) {
      if (resting.has(level)) continue;
      const qty = roundQty(config.usdtPerLevel, level);
      if (qty > 0) plan.placeBids.push({ gridLevel: level, price: level, qty });
    }
  }

  // --- exit side -------------------------------------------------------------
  //
  // Sells are NOT rested on the book. A resting sell at the target would be
  // filled by the exchange the moment price touches it, which is before the bot
  // next polls — so a hold_sell rule could never actually stop it. Instead the
  // sell is only submitted once price has already reached the target and the
  // rules have had their say. This is the same reason the source strategy is
  // traded by hand: keeping the exit decision, rather than parking it on the
  // book, is what makes holding for a bigger move possible at all.
  const hold = evaluateRules(snapshot, lessons, 'hold_sell');

  for (const lot of positions.lots) {
    const target = sellTargetFor(lot, levels);
    if (target === undefined) continue; // lot sits above the top of the grid

    // An order submitted last tick that has not filled yet still counts as in flight.
    const inFlight = lot.sellOrderId !== undefined;
    const reachedTarget = snapshot.price >= target;

    if (!hold.allowed) {
      if (inFlight) plan.cancelSells.push(lot);
      // Only a lot that would otherwise be sold right now is genuinely "held";
      // logging every lot on every tick would drown the log in non-events.
      if (inFlight || reachedTarget) {
        if (lot.heldBy !== hold.blockedBy) {
          plan.skipped.push(
            decision('exit_held', target, snapshot.price, {
              blockedBy: hold.blockedBy,
              lotId: lot.id,
              entryPrice: lot.entryPrice,
              qty: lot.qty,
            }),
          );
        }
        plan.holdState.push({ lot, blockedBy: hold.blockedBy });
      } else {
        plan.holdState.push({ lot, blockedBy: undefined });
      }
      continue;
    }

    plan.holdState.push({ lot, blockedBy: undefined });
    if (!inFlight && reachedTarget) {
      // Priced at the target, not at market: with price already at or above it
      // this fills immediately, and can never fill below the target.
      plan.placeSells.push({ lot, targetLevel: target, price: target, qty: lot.qty });
    }
  }

  return plan;
}

/** Convenience for logs and the evaluator report. */
export function describeBid(b: PendingBid): string {
  return `${b.qty}@${b.price}`;
}
