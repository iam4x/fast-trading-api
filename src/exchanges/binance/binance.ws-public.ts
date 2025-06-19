import type { BinanceWorker } from "./binance.worker";

import { tryParse } from "~/utils/try-parse.utils";
import { genIntId } from "~/utils/gen-id.utils";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import type { Candle, Timeframe } from "~/types/lib.types";

type JSONData = Record<string, any> | Array<Record<string, any>>;

export class BinanceWsPublic {
  parent: BinanceWorker;
  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (data: JSONData) => void> = {};

  ohlcvTopics = new Set<string>();
  ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent }: { parent: BinanceWorker }) {
    this.parent = parent;
    this.messageHandlers["24hrTicker"] = this.handleTickerStream;
    this.messageHandlers.bookTicker = this.handleBookTicker;
    this.messageHandlers.markPriceUpdate = this.handleMarkPriceUpdate;
    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_PUBLIC_URL);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = () => {
    this.parent.log(`Binance Public Websocket Opened`);

    this.ping();

    this.send({
      id: genIntId(),
      method: "SUBSCRIBE",
      params: ["!ticker@arr", "!bookTicker", "!markPrice@arr@1s"],
    });

    if (this.ohlcvTopics.size > 0) {
      this.send({
        id: genIntId(),
        method: "SUBSCRIBE",
        params: Array.from(this.ohlcvTopics),
      });
    }
  };

  onMessage = (event: MessageEvent) => {
    const data = tryParse<JSONData>(event.data);

    if (data) {
      for (const key in this.messageHandlers) {
        this.messageHandlers[key](data);
      }
    }
  };

  ping = () => {
    this.interval = setInterval(() => {
      this.send({ id: genIntId(), method: "LIST_SUBSCRIPTIONS" });
    }, 10_000);
  };

  handleTickerStream = (data: JSONData) => {
    if (Array.isArray(data) && data[0].e === "24hrTicker") {
      for (const ticker of data) {
        if (ticker.s in this.parent.memory.public.tickers) {
          this.parent.updateTickerDelta({
            symbol: ticker.s,
            last: parseFloat(ticker.c),
            percentage: parseFloat(ticker.P),
            volume: parseFloat(ticker.v),
            quoteVolume: parseFloat(ticker.q),
          });
        }
      }
    }
  };

  handleBookTicker = (data: JSONData) => {
    if (Array.isArray(data) && data[0].e === "bookTicker") {
      for (const ticker of data) {
        if (ticker.s in this.parent.memory.public.tickers) {
          this.parent.updateTickerDelta({
            symbol: ticker.s,
            bid: parseFloat(ticker.b),
            ask: parseFloat(ticker.a),
          });
        }
      }
    }
  };

  handleMarkPriceUpdate = (data: JSONData) => {
    if (Array.isArray(data) && data[0].e === "markPriceUpdate") {
      for (const ticker of data) {
        if (ticker.s in this.parent.memory.public.tickers) {
          this.parent.updateTickerDelta({
            symbol: ticker.s,
            mark: parseFloat(ticker.p),
            index: parseFloat(ticker.i),
            fundingRate: parseFloat(ticker.r),
          });
        }
      }
    }
  };

  onClose = () => {
    this.parent.error(`Binance Public Websocket Closed`);

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  listenOHLCV = ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) => {
    const topic = `${symbol.toLowerCase()}@kline_${timeframe}`;

    if (this.ohlcvTopics.has(topic)) return;
    this.ohlcvTopics.add(topic);

    this.messageHandlers[topic] = (data: JSONData) => {
      if (
        !Array.isArray(data) &&
        data.e === "kline" &&
        data.k.s === symbol &&
        data.k.i === timeframe
      ) {
        const candle: Candle = {
          symbol,
          timeframe,
          timestamp: data.k.t / 1000,
          open: parseFloat(data.k.o),
          high: parseFloat(data.k.h),
          low: parseFloat(data.k.l),
          close: parseFloat(data.k.c),
          volume: parseFloat(data.k.v),
        };

        this.parent.emitCandle(candle);
      }
    };

    const waitConnectAndSubscribe = () => {
      if (this.ohlcvTimeouts.has(topic)) {
        clearTimeout(this.ohlcvTimeouts.get(topic));
        this.ohlcvTimeouts.delete(topic);
      }

      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.ohlcvTimeouts.set(
          topic,
          setTimeout(() => waitConnectAndSubscribe(), 100),
        );
        return;
      }

      this.send({ id: genIntId(), method: "SUBSCRIBE", params: [topic] });
    };

    waitConnectAndSubscribe();
  };

  unlistenOHLCV = ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) => {
    const topic = `${symbol.toLowerCase()}@kline_${timeframe}`;
    const timeout = this.ohlcvTimeouts.get(topic);

    if (timeout) {
      clearTimeout(timeout);
      this.ohlcvTimeouts.delete(topic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ id: genIntId(), method: "UNSUBSCRIBE", params: [topic] });
    }

    delete this.messageHandlers[topic];
    this.ohlcvTopics.delete(topic);
  };

  // listenOrderBook = (symbol: string) => {};

  // unlistenOrderBook = (symbol: string) => {};

  send = (data: Record<string, any>) => {
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
