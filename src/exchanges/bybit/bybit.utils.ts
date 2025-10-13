import type {
  BybitBalance,
  BybitOrder,
  BybitPlaceOrderOpts,
  BybitPosition,
  BybitTicker,
  BybitWebsocketPosition,
} from "./bybit.types";
import {
  ORDER_TIME_IN_FORCE_INVERSE,
  ORDER_SIDE_INVERSE,
  ORDER_TYPE_INVERSE,
  ORDER_SIDE,
  ORDER_STATUS,
  ORDER_TYPE,
} from "./bybit.config";

import {
  ExchangeName,
  OrderSide,
  OrderTimeInForce,
  OrderType,
  PositionSide,
  type Fill,
  type Market,
  type Order,
  type PlaceOrderOpts,
  type Position,
  type Ticker,
} from "~/types/lib.types";
import { adjust, subtract } from "~/utils/safe-math.utils";
import { TICKER_REGEX } from "~/utils/regex.utils";
import { omitUndefined } from "~/utils/omit-undefined.utils";
import { times } from "~/utils/times.utils";
import { toUSD } from "~/utils/to-usd.utils";

export const mapBybitTicker = (t: BybitTicker): Ticker => {
  return {
    id: t.symbol,
    symbol: t.symbol,
    exchange: ExchangeName.BYBIT,
    cleanSymbol: t.symbol.replace(TICKER_REGEX, ""),
    bid: parseFloat(t.bid1Price),
    ask: parseFloat(t.ask1Price),
    last: parseFloat(t.lastPrice),
    mark: parseFloat(t.markPrice),
    index: parseFloat(t.indexPrice),
    percentage: parseFloat(t.price24hPcnt) * 100,
    openInterest: parseFloat(t.openInterest),
    nextFundingTime: parseFloat(t.nextFundingTime),
    fundingRate: parseFloat(t.fundingRate),
    volume: parseFloat(t.volume24h),
    quoteVolume: parseFloat(t.volume24h) * parseFloat(t.lastPrice),
  };
};

export const mapBybitBalance = (b?: BybitBalance) => {
  if (!b) {
    return { total: 0, upnl: 0, used: 0, free: 0 };
  }

  const upnl = toUSD(parseFloat(b.totalPerpUPL));
  const total = toUSD(parseFloat(b.totalEquity) - upnl);
  const free = toUSD(parseFloat(b.totalMarginBalance));
  const used = toUSD(
    parseFloat(b.totalMaintenanceMargin) + parseFloat(b.totalInitialMargin),
  );

  return { total, upnl, used, free };
};

export const mapBybitPosition = ({
  position: p,
  accountId,
}: {
  position: BybitPosition | BybitWebsocketPosition;
  accountId: string;
}): Position => {
  return {
    exchange: ExchangeName.BYBIT,
    accountId,
    symbol: p.symbol,
    side: p.side === "Buy" ? PositionSide.Long : PositionSide.Short,
    entryPrice: parseFloat("avgPrice" in p ? p.avgPrice : p.entryPrice),
    notional: toUSD(parseFloat(p.positionValue) + parseFloat(p.unrealisedPnl)),
    leverage: parseFloat(p.leverage),
    upnl: toUSD(parseFloat(p.unrealisedPnl)),
    rpnl: toUSD(parseFloat(p.curRealisedPnl)),
    contracts: parseFloat(p.size || "0"),
    liquidationPrice: parseFloat(p.liqPrice || "0"),
    isHedged: p.positionIdx !== 0,
  };
};

export const mapBybitOrder = ({
  order: o,
  accountId,
}: {
  order: BybitOrder;
  accountId: string;
}): Order[] => {
  const isStop = o.stopOrderType !== "UNKNOWN" && o.stopOrderType !== "";

  const oPrice = isStop ? o.triggerPrice : o.price;
  const oType = isStop ? o.stopOrderType : o.orderType;

  const orders: Order[] = [
    {
      id: o.orderId,
      exchange: ExchangeName.BYBIT,
      accountId,
      status: ORDER_STATUS[o.orderStatus],
      symbol: o.symbol,
      type: ORDER_TYPE[oType as keyof typeof ORDER_TYPE],
      side: ORDER_SIDE[o.side as keyof typeof ORDER_SIDE],
      price: parseFloat(oPrice),
      amount: parseFloat(o.qty || "0"),
      filled: parseFloat(o.cumExecQty || "0"),
      reduceOnly: o.reduceOnly || false,
      remaining: subtract(
        parseFloat(o.qty || "0"),
        parseFloat(o.cumExecQty || "0"),
      ),
      timestamp: parseInt(o.updatedTime, 10),
    },
  ];

  const sl = parseFloat(o.stopLoss);
  const tp = parseFloat(o.takeProfit);

  const inverseSide =
    orders[0].side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy;

  if (sl > 0) {
    orders.push({
      ...orders[0],
      id: `${o.orderId}__stop_loss`,
      type: OrderType.StopLoss,
      side: inverseSide,
      price: sl,
      filled: 0,
      remaining: orders[0].amount,
    });
  }

  if (tp > 0) {
    orders.push({
      ...orders[0],
      id: `${o.orderId}__take_profit`,
      type: OrderType.TakeProfit,
      side: inverseSide,
      price: tp,
      filled: 0,
      remaining: orders[0].amount,
    });
  }

  return orders;
};

export const mapBybitFill = (o: BybitOrder) => {
  const isStop = o.stopOrderType !== "UNKNOWN" && o.stopOrderType !== "";
  const oPrice = isStop ? o.triggerPrice : o.price;

  const fill: Fill = {
    symbol: o.symbol,
    side: ORDER_SIDE[o.side as keyof typeof ORDER_SIDE],
    price: parseFloat(oPrice),
    amount: parseFloat(o.qty || "0"),
    timestamp: parseInt(o.updatedTime, 10),
  };

  return fill;
};

export const formatMarkerOrLimitOrder = ({
  order,
  market,
  isHedged,
}: {
  order: PlaceOrderOpts;
  market: Market;
  isHedged?: boolean;
}): BybitPlaceOrderOpts[] => {
  const positionIdx: 0 | 1 | 2 = isHedged
    ? getHedgedOrderPositionIdx(order)
    : 0;

  const maxSize =
    order.type === OrderType.Market
      ? market.limits.amount.maxMarket
      : market.limits.amount.max;

  const pPrice = market.precision.price;
  const pAmount = market.precision.amount;

  const amount = adjust(order.amount, pAmount);
  const price = order.price ? adjust(order.price, pPrice) : undefined;

  const timeInForce =
    ORDER_TIME_IN_FORCE_INVERSE[
      order.timeInForce || OrderTimeInForce.GoodTillCancel
    ];

  const req = omitUndefined({
    category: "linear",
    symbol: order.symbol,
    side: ORDER_SIDE_INVERSE[order.side],
    orderType: ORDER_TYPE_INVERSE[order.type],
    qty: `${amount}`,
    price: order.type === OrderType.Limit ? `${price}` : undefined,
    reduceOnly: order.reduceOnly || false,
    timeInForce: order.type === OrderType.Limit ? timeInForce : undefined,
    closeOnTrigger: false,
    positionIdx,
  });

  const lots = amount > maxSize ? Math.ceil(amount / maxSize) : 1;
  const rest = amount > maxSize ? adjust(amount % maxSize, pAmount) : 0;

  const lotSize = adjust((amount - rest) / lots, pAmount);
  const payloads = times(lots, () => ({ ...req, qty: `${lotSize}` }));
  if (rest > 0) payloads.push({ ...req, qty: `${rest}` });

  return payloads;
};

export const getHedgedOrderPositionIdx = (
  order:
    | Pick<BybitPlaceOrderOpts, "side" | "reduceOnly">
    | Pick<PlaceOrderOpts, "side" | "reduceOnly">,
): 1 | 2 => {
  if (order.side === "Buy" || order.side === OrderSide.Buy) {
    return order.reduceOnly ? 2 : 1;
  }

  if (order.side === "Sell" || order.side === OrderSide.Sell) {
    return order.reduceOnly ? 1 : 2;
  }

  throw new Error(`Invalid order side: ${order.side}`);
};
