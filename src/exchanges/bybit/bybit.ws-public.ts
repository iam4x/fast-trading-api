import { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";

import { INTERVAL, ORDER_BOOK_DEPTH } from "./bybit.config";
import type { BybitTicker } from "./bybit.types";
import { mapBybitTicker } from "./bybit.utils";
import type { BybitWorker } from "./bybit.worker";

import { calcOrderBookTotal, sortOrderBook } from "~/utils/orderbook.utils";
import {
  type Candle,
  type OrderBook,
  type Ticker,
  type Timeframe,
} from "~/types/lib.types";
import { mapObj } from "~/utils/map-obj.utils";
import { tryParse } from "~/utils/try-parse.utils";

export class BybitWsPublic {
  parent: BybitWorker;
  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (event: MessageEvent) => void> = {};

  orderBookTopics = new Set<string>();
  orderBookTimeouts = new Map<string, NodeJS.Timeout>();

  ohlcvTopics = new Set<string>();
  ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent }: { parent: BybitWorker }) {
    this.parent = parent;
    this.messageHandlers.tickers = this.handleTickers;
    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_PUBLIC_URL);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = () => {
    this.parent.log(`Bybit Public Websocket Opened`);

    this.ping();

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.markets, (m) => `tickers.${m}`),
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

  ping = () => {
    this.interval = setInterval(() => {
      this.send({ op: "ping" });
    }, 10_000);
  };

  onMessage = (event: MessageEvent) => {
    for (const key in this.messageHandlers) {
      this.messageHandlers[key](event);
    }
  };

  handleTickers = (event: MessageEvent) => {
    if (event.data.startsWith('{"topic":"tickers.')) {
      const json = tryParse<{ type: string; data: BybitTicker }>(event.data);
      if (!json) return;

      if (json.type === "snapshot") {
        const d: BybitTicker = json.data;
        const t: Ticker = mapBybitTicker(d);
        this.parent.updateTicker(t);
        return;
      }

      if (json.type === "delta") {
        const d: BybitTicker = json.data;
        const t: Partial<Ticker> & { symbol: string } = {
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
        if (d.nextFundingTime) {
          t.nextFundingTime = parseFloat(d.nextFundingTime);
        }

        this.parent.updateTickerDelta(t);
        return;
      }
    }
  };

  listenOHLCV({ symbol, timeframe }: { symbol: string; timeframe: Timeframe }) {
    const ohlcvTopic = `kline.${INTERVAL[timeframe]}.${symbol}`;

    if (this.ohlcvTopics.has(ohlcvTopic)) return;
    this.ohlcvTopics.add(ohlcvTopic);

    this.messageHandlers[ohlcvTopic] = (event: MessageEvent) => {
      if (event.data.startsWith(`{"topic":"${ohlcvTopic}`)) {
        const json = tryParse<{ data: any }>(event.data);
        if (!json) return;

        const {
          data: [c],
        } = json;

        const candle: Candle = {
          symbol,
          timeframe,
          timestamp: c.start / 1000,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.turnover),
        };

        this.parent.emitCandle(candle);
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

  unlistenOHLCV({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
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

  listenOrderBook(symbol: string) {
    const orderBook: OrderBook = { bids: [], asks: [] };
    const orderBookTopic = `orderbook.${ORDER_BOOK_DEPTH}.${symbol}`;

    if (this.orderBookTopics.has(orderBookTopic)) return;
    this.orderBookTopics.add(orderBookTopic);

    this.messageHandlers[orderBookTopic] = (event: MessageEvent) => {
      if (event.data.startsWith(`{"topic":"${orderBookTopic}"`)) {
        const json = tryParse<{ type: string; data: any }>(event.data);
        if (!json) return;

        const { type, data } = json;

        if (type === "snapshot") {
          orderBook.bids = [];
          orderBook.asks = [];

          for (const key in data as Record<string, string[][]>) {
            if (key !== "a" && key !== "b") continue;

            const sideKey = key === "a" ? "asks" : "bids";
            const orders = data[key];

            orders.forEach((order: string[]) => {
              orderBook[sideKey].push({
                price: parseFloat(order[0]),
                amount: parseFloat(order[1]),
                total: 0,
              });
            });
          }
        }

        if (type === "delta") {
          for (const key in data as Record<string, string[][]>) {
            if (key !== "a" && key !== "b") continue;

            const orderKey = key === "a" ? "asks" : "bids";
            const orders = data[key];

            orders.forEach((order: string[]) => {
              const price = parseFloat(order[0]);
              const amount = parseFloat(order[1]);

              const index = orderBook[orderKey].findIndex(
                (o) => o.price === price,
              );

              if (index === -1 && amount > 0) {
                orderBook[orderKey].push({ price, amount, total: 0 });
                return;
              }

              if (index !== -1 && amount === 0) {
                orderBook[orderKey].splice(index, 1);
                return;
              }

              if (index !== -1 && amount > 0) {
                orderBook[orderKey][index].amount = amount;
              }
            });
          }
        }

        sortOrderBook(orderBook);
        calcOrderBookTotal(orderBook);

        this.parent.emitOrderBook({ symbol, orderBook });
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

  unlistenOrderBook(symbol: string) {
    const orderBookTopic = `orderbook.${ORDER_BOOK_DEPTH}.${symbol}`;
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
  }

  onClose = () => {
    this.parent.error(`Bybit Public Websocket Closed`);

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  send = (data: { op: string; args?: string[] }) => {
    if (!this.isStopped) this.ws?.send(JSON.stringify(data));
  };

  stop = () => {
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
