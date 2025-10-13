import { bybit } from "./bybit.api";
import { BYBIT_ENDPOINTS, INTERVAL } from "./bybit.config";
import type {
  BybitBalance,
  BybitInstrument,
  BybitOrder,
  BybitPosition,
  BybitTicker,
} from "./bybit.types";
import {
  getHedgedOrderPositionIdx,
  mapBybitBalance,
  mapBybitOrder,
  mapBybitFill,
  mapBybitPosition,
  mapBybitTicker,
} from "./bybit.utils";

import { retry } from "~/utils/retry.utils";
import {
  OrderType,
  type Account,
  type Candle,
  type Market,
  type Order,
  type PlaceOrderOpts,
  type Position,
  type Ticker,
  type FetchOHLCVParams,
  ExchangeName,
  type ExchangeConfig,
  type Fill,
} from "~/types/lib.types";
import { omitUndefined } from "~/utils/omit-undefined.utils";
import { orderBy } from "~/utils/order-by.utils";
import { adjust } from "~/utils/safe-math.utils";
import { stringify } from "~/utils/query-string.utils";
import { request } from "~/utils/request.utils";

export const fetchBybitMarkets = async (config: ExchangeConfig) => {
  const {
    result: { list },
  } = await request<{ result: { list: BybitInstrument[] } }>({
    url: `${config.PUBLIC_API_URL}${BYBIT_ENDPOINTS.PUBLIC.MARKETS}?category=linear&limit=1000`,
  });

  const markets: Record<string, Market> = list.reduce(
    (acc, market) => {
      if (market.quoteCoin !== "USDT") return acc;
      if (market.contractType !== "LinearPerpetual") return acc;

      acc[market.symbol] = {
        id: market.symbol,
        exchange: ExchangeName.BYBIT,
        symbol: market.symbol,
        base: market.baseCoin,
        quote: market.quoteCoin,
        active: market.status === "Trading",
        fundingInterval: market.fundingInterval,
        precision: {
          amount: parseFloat(market.lotSizeFilter.qtyStep),
          price: parseFloat(market.priceFilter.tickSize),
        },
        limits: {
          amount: {
            min: parseFloat(market.lotSizeFilter.minOrderQty),
            max: parseFloat(market.lotSizeFilter.maxOrderQty),
            maxMarket: parseFloat(market.lotSizeFilter.maxMktOrderQty),
          },
          leverage: {
            min: parseFloat(market.leverageFilter.minLeverage),
            max: parseFloat(market.leverageFilter.maxLeverage),
          },
        },
      };

      return acc;
    },
    {} as { [key: string]: Market },
  );

  return markets;
};

export const fetchBybitTickers = async ({
  config,
  markets,
}: {
  config: ExchangeConfig;
  markets?: Record<string, Market>;
}) => {
  const {
    result: { list },
  } = await request<{ result: { list: BybitTicker[] } }>({
    url: `${config.PUBLIC_API_URL}${BYBIT_ENDPOINTS.PUBLIC.TICKERS}?category=linear&limit=1000`,
  });

  const tickers: Record<string, Ticker> = list.reduce(
    (acc, t) => {
      if (markets && markets[t.symbol] === undefined) return acc;

      const ticker = mapBybitTicker(t);
      acc[ticker.symbol] = ticker;

      return acc;
    },
    {} as Record<string, Ticker>,
  );

  return tickers;
};

export const fetchBybitBalance = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const json = await bybit<{ result: { list: BybitBalance[] } }>({
    key: account.apiKey,
    secret: account.apiSecret,
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.BALANCE}`,
    params: { accountType: "UNIFIED" },
    retries: 3,
  });

  const [firstAccount] = json.result.list || [];
  return mapBybitBalance(firstAccount);
};

export const fetchBybitPositions = async ({
  account,
  config,
  markets,
}: {
  config: ExchangeConfig;
  account: Account;
  markets: Record<string, Market>;
}) => {
  const json = await bybit<{ result: { list: BybitPosition[] } }>({
    key: account.apiKey,
    secret: account.apiSecret,
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.POSITIONS}`,
    params: { category: "linear", settleCoin: "USDT", limit: 200 },
    retries: 3,
  });

  const positions: Position[] = json.result.list
    .filter((p) => p.symbol in markets)
    .map((p) => mapBybitPosition({ position: p, accountId: account.id }));

  return positions;
};

export const fetchBybitSymbolPositions = async ({
  config,
  account,
  symbol,
}: {
  config: ExchangeConfig;
  account: Account;
  symbol: string;
}) => {
  const json = await bybit<{ result: { list: BybitPosition[] } }>({
    key: account.apiKey,
    secret: account.apiSecret,
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.POSITIONS}`,
    params: { category: "linear", symbol },
    retries: 3,
  });

  const positions: Position[] = json.result.list?.map((p) =>
    mapBybitPosition({ position: p, accountId: account.id }),
  );

  return positions ?? [];
};

export const fetchBybitOrders = async ({
  account,
  config,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const recursiveFetch = async (
    cursor: string = "",
    orders: BybitOrder[] = [],
  ) => {
    const json = await bybit<{
      result: { list: BybitOrder[]; nextPageCursor?: string };
    }>({
      key: account.apiKey,
      secret: account.apiSecret,
      url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.ORDERS}`,
      params: {
        category: "linear",
        settleCoin: "USDT",
        openOnly: 0,
        limit: 50,
        cursor,
      },
      retries: 3,
    });

    const ordersList = Array.isArray(json.result.list) ? json.result.list : [];

    if (ordersList.length !== 50) {
      return orders.concat(ordersList);
    }

    if (json.result.nextPageCursor) {
      return recursiveFetch(
        json.result.nextPageCursor,
        orders.concat(ordersList),
      );
    }

    return ordersList;
  };

  const bybitOrders: BybitOrder[] = await recursiveFetch();
  const orders: Order[] = bybitOrders.flatMap((o) =>
    mapBybitOrder({ accountId: account.id, order: o }),
  );

  return orders;
};

export const fetchBybitOrdersHistory = async ({
  account,
  config,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const recursiveFetch = async (
    cursor: string = "",
    orders: BybitOrder[] = [],
  ) => {
    const json = await bybit<{
      result: { list: BybitOrder[]; nextPageCursor?: string };
    }>({
      key: account.apiKey,
      secret: account.apiSecret,
      url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.ORDERS_HISTORY}`,
      params: {
        category: "linear",
        settleCoin: "USDT",
        orderStatus: "Filled",
        limit: 50,
        cursor,
      },
    });

    const ordersList = Array.isArray(json.result.list) ? json.result.list : [];

    if (ordersList.length !== 50) {
      return orders.concat(ordersList);
    }

    // Limit to 5 pages to fetch?
    if (json.result.nextPageCursor && orders.length <= 250) {
      return recursiveFetch(
        json.result.nextPageCursor,
        orders.concat(ordersList),
      );
    }

    return orders;
  };

  const bybitOrders: BybitOrder[] = await recursiveFetch();
  const fills: Fill[] = bybitOrders.map(mapBybitFill);

  return fills;
};

export const fetchBybitOHLCV = async ({
  config,
  params,
}: {
  config: ExchangeConfig;
  params: FetchOHLCVParams;
}) => {
  const limit = Math.min(params.limit || 500, 1000);
  const interval = INTERVAL[params.timeframe];

  const urlParams = omitUndefined({
    category: "linear",
    symbol: params.symbol,
    start: params.from,
    end: params.to,
    interval,
    limit,
  });

  const response = await retry(() =>
    fetch(
      `${config.PUBLIC_API_URL}${BYBIT_ENDPOINTS.PUBLIC.KLINE}?${stringify(urlParams)}`,
    ),
  );

  const {
    result: { list },
  }: { result: { list: string[][] } } = await response.json();

  const candles: Candle[] = list.map(
    ([time, open, high, low, close, , volume]) => ({
      symbol: params.symbol,
      timeframe: params.timeframe,
      timestamp: parseFloat(time) / 1000,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }),
  );

  return orderBy(candles, ["timestamp"], ["asc"]);
};

export const createBybitTradingStop = async ({
  order,
  market,
  ticker,
  account,
  config,
  isHedged,
}: {
  order: PlaceOrderOpts;
  market: Market;
  ticker: Ticker;
  account: Account;
  config: ExchangeConfig;
  isHedged?: boolean;
}) => {
  const price = adjust(order.price ?? 0, market.precision.price);
  const body: Record<string, any> = {
    category: "linear",
    symbol: order.symbol,
    tpslMode: "Full",
    tpExchangeOrderType: "Market",
    slOrderType: "Market",
    positionIdx: isHedged ? getHedgedOrderPositionIdx(order) : 0,
  };

  if (order.type === OrderType.StopLoss) {
    body.stopLoss = `${price}`;
    body.slTriggerBy = "MarkPrice";
  }

  if (order.type === OrderType.TakeProfit) {
    body.takeProfit = `${price}`;
    body.tpTriggerBy = "LastPrice";
  }

  if (order.type === OrderType.TrailingStopLoss) {
    const distance = adjust(
      Math.max(ticker.last, price) - Math.min(ticker.last, price),
      market.precision.price,
    );

    body.trailingStop = `${distance}`;
  }

  const response = await bybit<{ retCode: number; retMsg: string }>({
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.TRADING_STOP}`,
    method: "POST",
    body,
    key: account.apiKey,
    secret: account.apiSecret,
  });

  if (response.retCode !== 0) {
    // TODO: Log error
    // use memory store for that as well ?
  }
};

export const setBybitLeverage = async ({
  account,
  config,
  symbol,
  leverage,
}: {
  account: Account;
  config: ExchangeConfig;
  symbol: string;
  leverage: number;
}) => {
  const response = await bybit<{ retCode: number; retMsg: string }>({
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.SET_LEVERAGE}`,
    method: "POST",
    body: {
      category: "linear",
      symbol,
      buyLeverage: `${leverage}`,
      sellLeverage: `${leverage}`,
    },
    key: account.apiKey,
    secret: account.apiSecret,
  });

  if (response.retCode !== 0) {
    // TODO: Log error
  }

  return response.retCode === 0;
};

export const cancelSymbolBybitOrders = async ({
  account,
  config,
  symbol,
}: {
  account: Account;
  config: ExchangeConfig;
  symbol: string;
}) => {
  const response = await bybit<{ retCode: number; retMsg: string }>({
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.CANCEL_ALL_ORDERS}`,
    method: "POST",
    body: {
      category: "linear",
      symbol,
    },
    key: account.apiKey,
    secret: account.apiSecret,
  });

  if (response.retCode !== 0) {
    // TODO: Log error
  }

  return response.retCode === 0;
};

export const cancelAllBybitOrders = async ({
  account,
  config,
}: {
  account: Account;
  config: ExchangeConfig;
}) => {
  const response = await bybit<{ retCode: number; retMsg: string }>({
    url: `${config.PRIVATE_API_URL}${BYBIT_ENDPOINTS.PRIVATE.CANCEL_ALL_ORDERS}`,
    method: "POST",
    body: {
      category: "linear",
      settleCoin: "USDT",
    },
    key: account.apiKey,
    secret: account.apiSecret,
  });

  if (response.retCode !== 0) {
    // TODO: Log error
  }

  return response.retCode === 0;
};
