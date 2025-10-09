import { OKX_ENDPOINTS } from "./okx.config";
import { tickerSymbolFromId } from "./okx.utils";

import { request } from "~/utils/request.utils";
import {
  ExchangeName,
  type ExchangeConfig,
  type Market,
  type Ticker,
} from "~/types/lib.types";
import { toUSD } from "~/utils/to-usd.utils";
import { TICKER_REGEX } from "~/utils/regex.utils";
import { deepMerge } from "~/utils/deep-merge.utils";

export const fetchOkxMarkets = async (config: ExchangeConfig) => {
  const { data } = await request<{ data: Record<string, any>[] }>({
    url: `${config.PUBLIC_API_URL}${OKX_ENDPOINTS.PUBLIC.MARKETS}`,
    params: { instType: "SWAP" },
    headers: deepMerge({}, config.options?.headers ?? {}),
  });

  const markets: Record<string, Market> = data.reduce(
    (acc, m) => {
      if (m.ctType !== "linear" || m.settleCcy !== "USDT") return acc;

      const tickerSymbol = tickerSymbolFromId(m.instId);

      const maxAmount = Math.min(
        parseFloat(m.maxIcebergSz),
        parseFloat(m.maxLmtSz),
        parseFloat(m.maxMktSz),
        parseFloat(m.maxStopSz),
        parseFloat(m.maxTriggerSz),
        parseFloat(m.maxTwapSz),
      );

      acc[tickerSymbol] = {
        id: m.instId,
        exchange: ExchangeName.OKX,
        symbol: tickerSymbol,
        base: m.ctValCcy,
        quote: m.settleCcy,
        active: m.state === "live",
        precision: {
          amount: parseFloat(m.ctVal),
          price: parseFloat(m.tickSz),
        },
        limits: {
          amount: {
            min: parseFloat(m.minSz) * parseFloat(m.ctVal),
            max: maxAmount,
          },
          leverage: {
            min: 1,
            max: parseFloat(m.lever),
          },
        },
      };

      return acc;
    },
    {} as { [key: string]: Market },
  );

  return markets;
};

export const fetchOkxTickers = async (config: ExchangeConfig) => {
  const { data } = await request<{ data: Record<string, any>[] }>({
    url: `${config.PUBLIC_API_URL}${OKX_ENDPOINTS.PUBLIC.TICKERS}`,
    params: { instType: "SWAP" },
    headers: deepMerge({}, config.options?.headers ?? {}),
  });

  const tickers: Record<string, Ticker> = data.reduce(
    (acc, t) => {
      const tickerSymbol = tickerSymbolFromId(t.instId);

      const open = parseFloat(t.open24h);
      const last = parseFloat(t.last);
      const percentage = toUSD(((last - open) / open) * 100);

      acc[tickerSymbol] = {
        id: t.instId,
        symbol: tickerSymbol,
        exchange: ExchangeName.OKX,
        cleanSymbol: tickerSymbol.replace(TICKER_REGEX, ""),
        bid: parseFloat(t.bidPx),
        ask: parseFloat(t.askPx),
        last,
        mark: last,
        index: last,
        percentage,
        openInterest: 0,
        fundingRate: 0,
        volume: parseFloat(t.volCcy24h),
        quoteVolume: parseFloat(t.vol24h),
      };

      return acc;
    },
    {} as { [key: string]: Ticker },
  );

  return tickers;
};
