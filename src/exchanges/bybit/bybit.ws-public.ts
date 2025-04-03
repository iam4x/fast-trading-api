import { BYBIT_API, INTERVAL } from "./bybit.config";
import type { BybitTicker } from "./bybit.types";
import { mapBybitTicker } from "./bybit.utils";
import type { BybitWorker } from "./bybit.worker";

import { calcOrderBookTotal, sortOrderBook } from "~/utils/orderbook.utils";
import {
  type ExchangeCandle,
  type ExchangeOrderBook,
  type ExchangeTicker,
  type ExchangeTimeframe,
} from "~/types/exchange.types";

export class BybitWsPublic {
  private parent: BybitWorker;
  private isStopped = false;

  private ws: WebSocket | null = null;
  private interval: NodeJS.Timeout | null = null;

  private markets: string[] = [];
  private messageHandlers: Record<string, (event: MessageEvent) => void> = {};

  private orderBookTopics = new Set<string>();
  private orderBookTimeouts = new Map<string, NodeJS.Timeout>();

  private ohlcvTopics = new Set<string>();
  private ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent, markets }: { parent: BybitWorker; markets: string[] }) {
    this.parent = parent;
    this.markets = markets;
    this.messageHandlers.tickers = this.handleTickers;

    this.listenWebsocket();
  }

  private listenWebsocket = () => {
    this.ws = new WebSocket(BYBIT_API.BASE_WS_PUBLIC_URL);
    this.ws.onopen = this.onOpen;
    this.ws.onerror = this.onError;
    this.ws.onmessage = this.onMessage;
    this.ws.onclose = this.onClose;
  };

  private onOpen = () => {
    this.ping();

    this.send({
      op: "subscribe",
      args: this.markets.map((m) => `tickers.${m}`),
    });

    if (this.orderBookTopics.size > 0) {
      this.send({
        op: "subscribe",
        args: Array.from(this.orderBookTopics),
      });
    }

    if (this.ohlcvTopics.size > 0) {
      this.send({
        op: "subscribe",
        args: Array.from(this.ohlcvTopics),
      });
    }
  };

  private ping = () => {
    this.interval = setInterval(() => {
      this.send({ op: "ping" });
    }, 10_000);
  };

  private onMessage = (event: MessageEvent) => {
    Object.values(this.messageHandlers).forEach((handler) => handler(event));
  };

  private onError = () => {};

  private handleTickers = (event: MessageEvent) => {
    if (event.data.startsWith('{"topic":"tickers.')) {
      const json = JSON.parse(event.data);

      if (json.type === "snapshot") {
        const d: BybitTicker = json.data;
        const t: ExchangeTicker = mapBybitTicker(d);
        this.parent.updateTicker(t);
      }

      if (json.type === "delta") {
        const d: BybitTicker = json.data;
        const t: Partial<ExchangeTicker> & { symbol: string } = {
          symbol: d.symbol,
        };

        if (d.bid1Price) t.bid = parseFloat(d.bid1Price);
        if (d.ask1Price) t.ask = parseFloat(d.ask1Price);
        if (d.lastPrice) t.last = parseFloat(d.lastPrice);
        if (d.markPrice) t.mark = parseFloat(d.markPrice);
        if (d.indexPrice) t.index = parseFloat(d.indexPrice);
        if (d.price24hPcnt) t.percentage = parseFloat(d.price24hPcnt) * 100;
        if (d.openInterest) t.openInterest = parseFloat(d.openInterest);
        if (d.fundingRate) t.fundingRate = parseFloat(d.fundingRate);
        if (d.volume24h) t.volume = parseFloat(d.volume24h);
        if (d.turnover24h) t.quoteVolume = parseFloat(d.turnover24h);

        this.parent.updateTickerDelta(t);
      }
    }
  };

  public listenOHLCV({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: ExchangeTimeframe;
  }) {
    const ohlcvTopic = `kline.${INTERVAL[timeframe]}.${symbol}`;

    if (this.ohlcvTopics.has(ohlcvTopic)) return;
    this.ohlcvTopics.add(ohlcvTopic);

    this.messageHandlers[ohlcvTopic] = (event: MessageEvent) => {
      if (event.data.startsWith(`{"topic":"${ohlcvTopic}`)) {
        const {
          data: [c],
        } = JSON.parse(event.data);

        const candle: ExchangeCandle & {
          symbol: string;
          timeframe: ExchangeTimeframe;
        } = {
          symbol,
          timeframe,
          timestamp: c.start / 1000,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.turnover),
        };

        this.parent.emitChanges([
          {
            type: "update",
            path: `public.ohlcv.${symbol}.${timeframe}`,
            value: candle,
          },
        ]);
      }
    };

    const waitConnectAndSubscribe = () => {
      if (this.ohlcvTimeouts.has(ohlcvTopic)) {
        clearTimeout(this.ohlcvTimeouts.get(ohlcvTopic));
        this.ohlcvTimeouts.delete(ohlcvTopic);
      }

      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.ohlcvTimeouts.set(
          ohlcvTopic,
          setTimeout(() => waitConnectAndSubscribe(), 100),
        );
        return;
      }

      this.send({ op: "subscribe", args: [ohlcvTopic] });
    };

    waitConnectAndSubscribe();
  }

  public unlistenOHLCV({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: ExchangeTimeframe;
  }) {
    const ohlcvTopic = `kline.${INTERVAL[timeframe]}.${symbol}`;
    const timeout = this.ohlcvTimeouts.get(ohlcvTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.ohlcvTimeouts.delete(ohlcvTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ op: "unsubscribe", args: [ohlcvTopic] });
    }

    delete this.messageHandlers[ohlcvTopic];
    this.ohlcvTopics.delete(ohlcvTopic);
  }

  public listenOrderBook(symbol: string) {
    const orderBook: ExchangeOrderBook = { bids: [], asks: [] };
    const orderBookTopic = `orderbook.500.${symbol}`;

    if (this.orderBookTopics.has(orderBookTopic)) return;
    this.orderBookTopics.add(orderBookTopic);

    this.messageHandlers[orderBookTopic] = (event: MessageEvent) => {
      if (event.data.startsWith(`{"topic":"${orderBookTopic}"`)) {
        const data = JSON.parse(event.data);

        if (data.type === "snapshot") {
          orderBook.bids = [];
          orderBook.asks = [];

          Object.entries(data.data as Record<string, string[][]>).forEach(
            ([side, orders]) => {
              if (side !== "a" && side !== "b") return;

              const key = side === "a" ? "asks" : "bids";
              orders.forEach((order: string[]) => {
                orderBook[key].push({
                  price: parseFloat(order[0]),
                  amount: parseFloat(order[1]),
                  total: 0,
                });
              });
            },
          );
        }

        if (data.type === "delta") {
          Object.entries(data.data as Record<string, string[][]>).forEach(
            ([side, orders]) => {
              if (side !== "a" && side !== "b") return;

              const key = side === "a" ? "asks" : "bids";
              orders.forEach((order) => {
                const price = parseFloat(order[0]);
                const amount = parseFloat(order[1]);

                const index = orderBook[key].findIndex(
                  (o) => o.price === price,
                );

                if (index === -1 && amount > 0) {
                  orderBook[key].push({ price, amount, total: 0 });
                  return;
                }

                if (amount === 0) {
                  orderBook[key].splice(index, 1);
                  return;
                }

                orderBook[key][index].amount = amount;
              });
            },
          );
        }

        sortOrderBook(orderBook);
        calcOrderBookTotal(orderBook);

        this.parent.emitChanges([
          {
            type: "update",
            path: `public.orderBooks.${symbol}`,
            value: orderBook,
          },
        ]);
      }
    };

    const waitConnectAndSubscribe = () => {
      if (this.orderBookTimeouts.has(orderBookTopic)) {
        clearTimeout(this.orderBookTimeouts.get(orderBookTopic));
        this.orderBookTimeouts.delete(orderBookTopic);
      }

      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.orderBookTimeouts.set(
          orderBookTopic,
          setTimeout(() => waitConnectAndSubscribe(), 100),
        );
        return;
      }

      this.send({ op: "subscribe", args: [orderBookTopic] });
    };

    waitConnectAndSubscribe();
  }

  public unlistenOrderBook(symbol: string) {
    const orderBookTopic = `orderbook.500.${symbol}`;
    const timeout = this.orderBookTimeouts.get(orderBookTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.orderBookTimeouts.delete(orderBookTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ op: "unsubscribe", args: [orderBookTopic] });
    }

    delete this.messageHandlers[orderBookTopic];
    this.orderBookTopics.delete(orderBookTopic);

    this.parent.emitChanges([
      {
        type: "update",
        path: `public.orderBooks.${symbol}`,
        value: { bids: [], asks: [] },
      },
    ]);
  }

  private onClose = () => {
    if (this.isStopped) return;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.ws = null;
    this.listenWebsocket();
  };

  private send = (data: { op: string; args?: string[] }) => {
    if (!this.isStopped) this.ws?.send(JSON.stringify(data));
  };

  public stop = () => {
    this.isStopped = true;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  };
}
