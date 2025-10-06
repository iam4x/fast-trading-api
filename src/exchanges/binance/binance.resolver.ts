import {
  BINANCE_ENDPOINTS,
  ORDER_SIDE,
  ORDER_TYPE,
  POSITION_SIDE,
} from "./binance.config";
import type {
  BinanceAccount,
  BinanceMarket,
  BinanceTicker24h,
  BinanceTickerBook,
  BinanceTickerPrice,
} from "./binance.types";
import { binance } from "./binance.api";

import {
  ExchangeName,
  PositionSide,
  type Position,
  type Account,
  type Balance,
  type ExchangeConfig,
  type Market,
  type Ticker,
  type FetchOHLCVParams,
  type Candle,
  type Order,
  OrderStatus,
  type Fill,
} from "~/types/lib.types";
import { request } from "~/utils/request.utils";
import { getKV } from "~/utils/get-kv.utils";
import { TICKER_REGEX } from "~/utils/regex.utils";
import { subtract } from "~/utils/safe-math.utils";

export const fetchBinanceMarkets = async (config: ExchangeConfig) => {
  const { symbols } = await request<{ symbols: BinanceMarket[] }>({
    url: `${config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.MARKETS}`,
  });

  const markets: Record<string, Market> = symbols.reduce(
    (acc, market) => {
      if (getKV(market, "contractType") !== "PERPETUAL") return acc;
      if (getKV(market, "marginAsset") !== "USDT") return acc;

      const p = market.filters.find(
        (f) => getKV(f, "filterType") === "PRICE_FILTER",
      );

      const amt = market.filters.find(
        (f) => getKV(f, "filterType") === "LOT_SIZE",
      );

      const mAmt = market.filters.find(
        (f) => getKV(f, "filterType") === "MARKET_LOT_SIZE",
      );

      acc[market.symbol] = {
        id: market.symbol,
        exchange: ExchangeName.BINANCE,
        symbol: market.symbol,
        base: getKV(market, "baseAsset"),
        quote: getKV(market, "quoteAsset"),
        active: market.status === "TRADING",
        precision: {
          amount: parseFloat(getKV(amt, "stepSize")),
          price: parseFloat(getKV(p, "tickSize")),
        },
        limits: {
          amount: {
            min: Math.max(
              parseFloat(getKV(amt, "minQty")),
              parseFloat(getKV(mAmt, "minQty")),
            ),
            max: Math.min(
              parseFloat(getKV(amt, "maxQty")),
              parseFloat(getKV(mAmt, "maxQty")),
            ),
            maxMarket: parseFloat(getKV(mAmt, "maxQty")),
          },
          leverage: {
            min: 1,
            // TODO: Get max leverage per account?
            // leverage brackets are computed per account for binance
            // we need to figure it out how to do this thing
            max: 100,
          },
        },
      };

      return acc;
    },
    {} as { [key: string]: Market },
  );

  return markets;
};

export const fetchBinanceTickers = async (config: ExchangeConfig) => {
  const [dailys, books, prices] = await Promise.all([
    request<BinanceTicker24h[]>({
      url: `${config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.TICKERS_24H}`,
    }),
    request<BinanceTickerBook[]>({
      url: `${config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.TICKERS_BOOK}`,
    }),
    request<BinanceTickerPrice[]>({
      url: `${config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.TICKERS_PRICE}`,
    }),
  ]);

  const tickers: Record<string, Ticker> = dailys.reduce(
    (acc, daily) => {
      const book = books.find((d) => d.symbol === daily.symbol);
      const price = prices.find((p) => p.symbol === daily.symbol);

      if (!daily || !book) return acc;

      acc[book.symbol] = {
        id: book.symbol,
        symbol: book.symbol,
        exchange: ExchangeName.BINANCE,
        cleanSymbol: book.symbol.replace(TICKER_REGEX, ""),
        bid: parseFloat(getKV(book, "bidPrice")),
        ask: parseFloat(getKV(book, "askPrice")),
        last: parseFloat(getKV(daily, "lastPrice")),
        mark: parseFloat(getKV(price, "markPrice")),
        index: parseFloat(getKV(price, "indexPrice")),
        percentage: parseFloat(getKV(daily, "priceChangePercent")),
        fundingRate: parseFloat(getKV(price, "lastFundingRate")),
        volume: parseFloat(daily.volume),
        quoteVolume: parseFloat(getKV(daily, "quoteVolume")),
        openInterest: 0, // Binance doesn't provides that in all tickers data
      };

      return acc;
    },
    {} as Record<string, Ticker>,
  );

  return tickers;
};

export const fetchBinanceAccount = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const data = await binance<BinanceAccount>({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.ACCOUNT}`,
    key: account.apiKey,
    secret: account.apiSecret,
  });

  const balance: Balance = {
    total: parseFloat(data.totalWalletBalance),
    free: parseFloat(data.availableBalance),
    used: parseFloat(data.totalInitialMargin),
    upnl: parseFloat(data.totalUnrealizedProfit),
  };

  const positions: Position[] = data.positions.map((p) => {
    const entryPrice = parseFloat(getKV(p, "entryPrice"));
    const contracts = parseFloat(getKV(p, "positionAmt"));
    const upnl = parseFloat(getKV(p, "unrealizedProfit"));
    const pSide = getKV(p, "positionSide");

    const side =
      (pSide in POSITION_SIDE && POSITION_SIDE[pSide]) ||
      (contracts > 0 ? PositionSide.Long : PositionSide.Short);

    return {
      exchange: ExchangeName.BINANCE,
      accountId: account.id,
      symbol: p.symbol,
      side,
      entryPrice,
      notional: Math.abs(contracts * entryPrice + upnl),
      leverage: parseFloat(p.leverage),
      upnl,
      rpnl: 0,
      contracts: Math.abs(contracts),
      liquidationPrice: 0,
      isHedged: pSide !== "BOTH",
    };
  });

  return {
    balance,
    positions: positions.filter((p) => p.contracts > 0),
  };
};

export const fetchBinanceOHLCV = async ({
  config,
  params,
}: {
  config: ExchangeConfig;
  params: FetchOHLCVParams;
}) => {
  const timeframe = params.timeframe;
  const limit = Math.min(params.limit ?? 500, 1500);
  const [, amount, unit] = timeframe.split(/(\d+)/);

  const end = params.to ? new Date(params.to) : new Date();
  const start =
    !params.limit && params.from
      ? new Date(params.from)
      : new Date(
          end.getTime() - parseFloat(amount) * limit * getTimeUnitInMs(unit),
        );

  const data = await request<any[][]>({
    url: `${config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.KLINE}`,
    params: {
      symbol: params.symbol,
      interval: timeframe,
      startTime: start.getTime(),
      endTime: end.getTime(),
      limit,
    },
  });

  const candles: Candle[] = data.map(
    ([time, open, high, low, close, volume]) => {
      return {
        symbol: params.symbol,
        timeframe,
        timestamp: time / 1000,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      };
    },
  );

  return candles;
};

export const fetchBinanceListenkey = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const data = await binance<{ listenKey: string }>({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.LISTEN_KEY}`,
    method: "POST",
    key: account.apiKey,
    secret: account.apiSecret,
  });

  return data.listenKey;
};

export const refreshBinanceListenkey = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  await binance<{ listenKey: string }>({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.LISTEN_KEY}`,
    method: "PUT",
    key: account.apiKey,
    secret: account.apiSecret,
  });
};

export const fetchBinanceOrders = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const data = await binance<Record<string, any>[]>({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.OPEN_ORDERS}`,
    key: account.apiKey,
    secret: account.apiSecret,
  });

  const orders: Order[] = data.map((o) => ({
    id: getKV(o, "clientOrderId"),
    exchange: ExchangeName.BINANCE,
    accountId: account.id,
    status: OrderStatus.Open,
    symbol: o.symbol,
    type: ORDER_TYPE[o.type],
    side: ORDER_SIDE[o.side],
    price: parseFloat(o.price) || parseFloat(getKV(o, "stopPrice")),
    amount: parseFloat(getKV(o, "origQty")),
    reduceOnly: getKV(o, "reduceOnly") || false,
    filled: parseFloat(getKV(o, "executedQty")),
    remaining: subtract(
      parseFloat(getKV(o, "origQty")),
      parseFloat(getKV(o, "executedQty")),
    ),
    timestamp: parseInt(o.time, 10),
  }));

  return orders;
};

export const fetchBinanceOrdersHistory = async ({
  config,
  account,
}: {
  config: ExchangeConfig;
  account: Account;
}) => {
  const data = await binance<Record<string, any>[]>({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.ORDERS_HISTORY}`,
    key: account.apiKey,
    secret: account.apiSecret,
  });

  const fills: Fill[] = data.map((o) => ({
    symbol: o.symbol,
    side: ORDER_SIDE[o.side],
    price: parseFloat(o.price),
    amount: parseFloat(o.origQty),
    timestamp: o.time,
  }));

  return fills;
};

export const cancelBinanceOrders = async ({
  config,
  account,
  symbol,
  origClientOrderIdList,
}: {
  config: ExchangeConfig;
  account: Account;
  symbol: string;
  origClientOrderIdList: (string | number)[];
}) => {
  await binance({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.BATCH_ORDERS}`,
    method: "DELETE",
    key: account.apiKey,
    secret: account.apiSecret,
    params: {
      symbol,
      origClientOrderIdList: JSON.stringify(origClientOrderIdList),
    },
  });
};

export const cancelBinanceSymbolOrders = async ({
  config,
  account,
  symbol,
}: {
  config: ExchangeConfig;
  account: Account;
  symbol: string;
}) => {
  await binance({
    url: `${config.PRIVATE_API_URL}${BINANCE_ENDPOINTS.PRIVATE.CANCEL_SYMBOL_ORDERS}`,
    method: "DELETE",
    key: account.apiKey,
    secret: account.apiSecret,
    params: {
      symbol,
    },
  });
};

const getTimeUnitInMs = (unit: string): number => {
  switch (unit.toLowerCase()) {
    case "m":
      return 60 * 1000;
    case "h":
      return 60 * 60 * 1000;
    case "d":
      return 24 * 60 * 60 * 1000;
    case "w":
      return 7 * 24 * 60 * 60 * 1000;
    case "M":
      return 30 * 24 * 60 * 60 * 1000;
    case "y":
      return 365 * 24 * 60 * 60 * 1000;
    default:
      return 60 * 1000; // default to minutes
  }
};
