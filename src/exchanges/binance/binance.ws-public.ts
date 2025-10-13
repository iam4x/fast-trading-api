import type { BinanceWorker } from "./binance.worker";
import { BINANCE_ENDPOINTS } from "./binance.config";
import { getBinanceNextFundingTime } from "./binance.utils";

import { tryParse } from "~/utils/try-parse.utils";
import { genIntId } from "~/utils/gen-id.utils";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import type { Candle, OrderBook, Timeframe } from "~/types/lib.types";
import { request } from "~/utils/request.utils";
import { calcOrderBookTotal, sortOrderBook } from "~/utils/orderbook.utils";

type JSONData = Record<string, any> | Array<Record<string, any>>;

export class BinanceWsPublic {
  parent: BinanceWorker;

  pingAt = 0;
  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (data: JSONData) => void> = {};

  orderBookTopics = new Set<string>();
  orderBookTimeouts = new Map<string, NodeJS.Timeout>();

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
      if ((data as any).id === 42) {
        const latency = (performance.now() - this.pingAt) / 2;
        this.parent.emitChanges([
          { type: "update", path: "public.latency", value: latency },
        ]);

        this.interval = setTimeout(() => {
          this.ping();
        }, 10_000);
      }

      for (const key in this.messageHandlers) {
        this.messageHandlers[key](data);
      }
    }
  };

  ping = () => {
    this.pingAt = performance.now();
    this.send({ id: 42, method: "LIST_SUBSCRIPTIONS" });
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
            nextFundingTime: getBinanceNextFundingTime(),
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

  listenOrderBook = (symbol: string) => {
    const orderBook: OrderBook = { bids: [], asks: [] };
    const orderBookTopic = `${symbol.toLowerCase()}@depth`;

    if (this.orderBookTopics.has(orderBookTopic)) return;
    this.orderBookTopics.add(orderBookTopic);

    const innerState = {
      updates: [] as any[],
      isSnapshotLoaded: false,
    };

    const fetchSnapshot = async () => {
      const data = await request<{
        bids: [string, string][];
        asks: [string, string][];
        lastUpdateId: number;
      }>({
        url: `${this.parent.config.PUBLIC_API_URL}${BINANCE_ENDPOINTS.PUBLIC.ORDERBOOK}`,
        params: { symbol, limit: 1000 },
      });

      if (!this.isStopped) {
        orderBook.bids = data.bids.map(([price, amount]: string[]) => ({
          price: parseFloat(price),
          amount: parseFloat(amount),
          total: 0,
        }));

        orderBook.asks = data.asks.map(([price, amount]: string[]) => ({
          price: parseFloat(price),
          amount: parseFloat(amount),
          total: 0,
        }));

        // drop events where u < lastUpdateId
        innerState.updates = innerState.updates.filter(
          (update: Record<string, any>) => update.u > data.lastUpdateId,
        );

        sortOrderBook(orderBook);
        calcOrderBookTotal(orderBook);

        innerState.isSnapshotLoaded = true;
        innerState.updates = [];

        this.parent.emitOrderBook({ symbol, orderBook });
      }
    };

    this.messageHandlers[orderBookTopic] = (data: JSONData) => {
      if (
        !Array.isArray(data) &&
        data.e === "depthUpdate" &&
        data.s === symbol
      ) {
        // first update request snapshot
        if (!innerState.isSnapshotLoaded && innerState.updates.length === 0) {
          fetchSnapshot();
          innerState.updates = [data];
          return;
        }

        // more updates, but snapshot is not loaded yet
        if (!innerState.isSnapshotLoaded) {
          innerState.updates.push(data);
          return;
        }

        // snapshot is loaded, apply updates and emit
        const sides = { bids: data.b, asks: data.a };
        Object.entries(sides).forEach(([side, orders]) => {
          // we need this for ts compile
          if (side !== "bids" && side !== "asks") return;

          orders.forEach(([p, a]: string[]) => {
            const price = parseFloat(p);
            const amount = parseFloat(a);
            const index = orderBook[side].findIndex((b) => b.price === price);

            if (index === -1 && amount > 0) {
              orderBook[side].push({ price, amount, total: 0 });
              return;
            }

            if (amount === 0) {
              orderBook[side].splice(index, 1);
              return;
            }

            orderBook[side][index].amount = amount;
          });
        });

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

      this.send({
        id: genIntId(),
        method: "SUBSCRIBE",
        params: [orderBookTopic],
      });
    };

    waitConnectAndSubscribe();
  };

  unlistenOrderBook = (symbol: string) => {
    const orderBookTopic = `${symbol.toLowerCase()}@depth`;
    const timeout = this.orderBookTimeouts.get(orderBookTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.orderBookTimeouts.delete(orderBookTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        id: genIntId(),
        method: "UNSUBSCRIBE",
        params: [orderBookTopic],
      });
    }

    delete this.messageHandlers[orderBookTopic];
    this.orderBookTopics.delete(orderBookTopic);
  };

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
