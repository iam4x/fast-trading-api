import type {
  HLUserAccount,
  HLUserOrder,
  HLUserOrderHistory,
} from "./hl.types";
import { HL_MAX_FIGURES } from "./hl.config";

import { adjust, subtract } from "~/utils/safe-math.utils";
import {
  ExchangeName,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  type Account,
  type Balance,
  type Fill,
  type Market,
  type Order,
  type PlaceOrderOpts,
  type Ticker,
  type UpdateOrderOpts,
} from "~/types/lib.types";
import { countFigures } from "~/utils/count-figures.utils";
import { sumBy } from "~/utils/sum-by.utils";
import { afterDecimals } from "~/utils/after-decimals.utils";

export const mapHLUserAccount = ({
  accountId,
  data: { assetPositions, crossMarginSummary },
}: {
  accountId: Account["id"];
  data: HLUserAccount;
}) => {
  const positions = assetPositions.map((p) => {
    const contracts = parseFloat(p.position.szi);

    return {
      accountId,
      exchange: ExchangeName.HL,
      symbol: p.position.coin,
      side: contracts > 0 ? PositionSide.Long : PositionSide.Short,
      entryPrice: parseFloat(p.position.entryPx),
      notional: parseFloat(p.position.positionValue),
      leverage: p.position.leverage.value,
      upnl: parseFloat(p.position.unrealizedPnl),
      rpnl: 0,
      contracts: Math.abs(contracts),
      liquidationPrice: parseFloat(p.position.liquidationPx) || 0,
      isHedged: p.type !== "oneWay",
    };
  });

  const upnl = sumBy(positions, (p) => p.upnl);
  const used = parseFloat(crossMarginSummary.totalMarginUsed);
  const total = subtract(parseFloat(crossMarginSummary.accountValue), upnl);
  const free = subtract(total, used);

  const balance: Balance = { used, free, total, upnl };

  return {
    balance,
    positions,
  };
};

const mapOrderType = (type: string) => {
  switch (type) {
    case "Limit":
      return OrderType.Limit;
    case "Take Profit Market":
      return OrderType.TakeProfit;
    case "Stop Market":
      return OrderType.StopLoss;
    default:
      return OrderType.Limit;
  }
};

export const mapHLOrder = ({
  order: o,
  accountId,
}: {
  order: HLUserOrder;
  accountId: string;
}) => {
  const amount = parseFloat(o.origSz);
  const remaining = parseFloat(o.sz);
  const filled = subtract(amount, remaining);

  const order: Order = {
    id: o.oid,
    exchange: ExchangeName.HL,
    accountId,
    status: OrderStatus.Open,
    symbol: o.coin,
    type: mapOrderType(o.orderType),
    side: o.side === "A" ? OrderSide.Sell : OrderSide.Buy,
    price:
      o.isPositionTpsl || o.isTrigger
        ? parseFloat(o.triggerPx)
        : parseFloat(o.limitPx),
    amount,
    filled,
    remaining,
    reduceOnly: o.reduceOnly || o.isPositionTpsl,
    timestamp: o.timestamp,
  };

  return order;
};

export const mapHLFill = (order: HLUserOrderHistory) => {
  const fill: Fill = {
    symbol: order.coin,
    side: order.side === "A" ? OrderSide.Sell : OrderSide.Buy,
    price: parseFloat(order.px),
    amount: parseFloat(order.sz),
    timestamp: order.time,
  };

  return fill;
};

export const formatHLOrderPrice = ({
  order,
  tickers,
  markets,
}: {
  order: { symbol: string; side: OrderSide; price?: number };
  tickers: Record<string, Ticker>;
  markets: Record<string, Market>;
}) => {
  const ticker = tickers[order.symbol];
  const market = markets[order.symbol];

  const pPrice = market.precision.price;
  const isBuy = order.side === OrderSide.Buy;

  let price = order.price;

  // HyperLiquid always need a price of order
  // if no price is provided we apply 1% slippage from last price
  if (!price) {
    price = isBuy
      ? ticker.last + ticker.last / 100
      : ticker.last - ticker.last / 100;
  }

  // We apply the adjust() function to round to maximal decimals accepted
  price = adjust(price, pPrice);

  // Now we check if we don't have too many "significant figures" in the price
  // meaning removing leading and trailling zeros and calculate the count of figures
  const significantFiguresCount = countFigures(price);

  if (significantFiguresCount > HL_MAX_FIGURES && !Number.isInteger(price)) {
    const diff = significantFiguresCount - HL_MAX_FIGURES;
    const newDecimalsCount = afterDecimals(price) - diff;

    // we apply Math.min(1, xxx) because any integer is accepted
    // we just want to remove decimals if there are too many
    const newPrecision = Math.min(1, 10 / 10 ** (newDecimalsCount + 1));

    price = adjust(price, newPrecision);
  }

  return price;
};

export const formatHLOrder = ({
  order,
  tickers,
  markets,
}: {
  order: PlaceOrderOpts;
  tickers: Record<string, Ticker>;
  markets: Record<string, Market>;
}) => {
  const market = markets[order.symbol];
  const pAmount = market.precision.amount;

  const isBuy = order.side === OrderSide.Buy;
  const isStop =
    order.type === OrderType.StopLoss ||
    order.type === OrderType.TakeProfit ||
    order.type === OrderType.TrailingStopLoss;

  const amount = adjust(order.amount, pAmount);
  const price = formatHLOrderPrice({ order, tickers, markets });

  // Condition order (SL/TP)
  // -----------------------
  if (isStop) {
    const priceWithSlippage = formatHLOrderPrice({
      order: {
        symbol: order.symbol,
        side: isBuy ? OrderSide.Sell : OrderSide.Buy,
        price: isBuy ? price - price * 0.1 : price + price * 0.1,
      },
      tickers,
      markets,
    });

    return {
      a: tickers[order.symbol].id as number,
      b: isBuy,
      p: priceWithSlippage.toString(),
      s: amount.toString(),
      r: true,
      t: {
        trigger: {
          isMarket: true,
          triggerPx: price.toString(),
          tpsl: order.type === OrderType.StopLoss ? "sl" : "tp",
        },
      },
    };
  }

  // Normal order market/limit
  // -------------------------
  return {
    a: tickers[order.symbol].id as number,
    b: isBuy,
    p: price.toString(),
    s: amount.toString(),
    r: order.reduceOnly,
    t: {
      limit: {
        tif: order.type === OrderType.Market ? "Ioc" : "Gtc",
      },
    },
  };
};

export const formatHLOrderUpdate = ({
  update: { order, update },
  tickers,
  markets,
}: {
  update: UpdateOrderOpts;
  tickers: Record<string, Ticker>;
  markets: Record<string, Market>;
}) => {
  const market = markets[order.symbol];
  const pAmount = market.precision.amount;

  const price =
    "price" in update
      ? formatHLOrderPrice({
          order: { ...order, price: update.price },
          tickers,
          markets,
        })
      : order.price;

  const isBuy = order.side === OrderSide.Buy;
  const isStop =
    order.type === OrderType.StopLoss ||
    order.type === OrderType.TakeProfit ||
    order.type === OrderType.TrailingStopLoss;

  const amount =
    "amount" in update ? adjust(update.amount, pAmount) : order.amount;

  if (isStop) {
    const priceWithSlippage = formatHLOrderPrice({
      order: {
        symbol: order.symbol,
        side: isBuy ? OrderSide.Buy : OrderSide.Sell,
        price: isBuy ? price + price * 0.1 : price - price * 0.1,
      },
      tickers,
      markets,
    });

    return {
      oid: order.id as number,
      order: {
        a: markets[order.symbol].id as number,
        b: isBuy,
        p: priceWithSlippage.toString(),
        s: amount.toString(),
        r: true,
        t: {
          trigger: {
            isMarket: true,
            triggerPx: price.toString(),
            tpsl: order.type === OrderType.StopLoss ? "sl" : "tp",
          },
        },
      },
    };
  }

  return {
    oid: order.id as number,
    order: {
      a: markets[order.symbol].id as number,
      b: isBuy,
      p: price.toString(),
      s: amount.toString(),
      r: order.reduceOnly,
      t: {
        limit: {
          tif: order.type === OrderType.Market ? "Ioc" : "Gtc",
        },
      },
    },
  };
};
