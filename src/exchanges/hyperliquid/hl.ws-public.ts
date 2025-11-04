import { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";

import type { HyperLiquidWorker } from "./hl.worker";
import type { HLActiveAssetCtxWs } from "./hl.types";

import type { Candle, OrderBook, Ticker, Timeframe } from "~/types/lib.types";
import { calcOrderBookTotal, sortOrderBook } from "~/utils/orderbook.utils";
import { tryParse } from "~/utils/try-parse.utils";

export class HyperLiquidWsPublic {
  parent: HyperLiquidWorker;

  pingAt = 0;
  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  pingTimeout: NodeJS.Timeout | null = null;

  pendingRequests = new Map<string, (data: any) => void>();
  messageHandlers: Record<string, (data: Record<string, any>) => void> = {};

  ohlcvTopics = new Set<string>();
  ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

  orderBookTopics = new Set<string>();
  orderBookTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent }: { parent: HyperLiquidWorker }) {
    this.parent = parent;
    this.messageHandlers.pong = this.handlePong;
    this.messageHandlers.activeAssetCtx = this.handleActiveAssets;
    this.listenWebSocket();
  }

  listenWebSocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_PUBLIC_URL);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  listenOHLCV = ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) => {
    const ohlcvTopic = `ohlcv.${symbol}.${timeframe}`;

    if (this.ohlcvTopics.has(ohlcvTopic)) return;
    this.ohlcvTopics.add(ohlcvTopic);

    this.messageHandlers[ohlcvTopic] = (json: Record<string, any>) => {
      if (
        json.channel === "candle" &&
        json.data.s === symbol &&
        json.data.i === timeframe
      ) {
        const candle: Candle = {
          symbol,
          timeframe,
          timestamp: Math.round(json.data.T / 1000),
          open: parseFloat(json.data.o),
          high: parseFloat(json.data.h),
          low: parseFloat(json.data.l),
          close: parseFloat(json.data.c),
          volume: parseFloat(json.data.v),
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

      this.subscribe({ type: "candle", coin: symbol, interval: timeframe });
    };

    waitConnectAndSubscribe();
  };

  unlistenOHLCV({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) {
    const ohlcvTopic = `ohlcv.${symbol}.${timeframe}`;
    const timeout = this.ohlcvTimeouts.get(ohlcvTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.ohlcvTimeouts.delete(ohlcvTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.unsubscribe({ type: "candle", coin: symbol, interval: timeframe });
    }

    delete this.messageHandlers[ohlcvTopic];
    this.ohlcvTopics.delete(ohlcvTopic);
  }

  listenOrderBook(symbol: string) {
    const orderBook: OrderBook = { bids: [], asks: [] };
    const orderBookTopic = `orderbook.${symbol}`;

    if (this.orderBookTopics.has(orderBookTopic)) return;
    this.orderBookTopics.add(orderBookTopic);

    this.messageHandlers[orderBookTopic] = (json: Record<string, any>) => {
      if (json.channel === "l2Book" && json.data.coin === symbol) {
        const [buySide, sellSide] = json.data.levels as Array<
          { px: string; sz: string }[]
        >;

        buySide.forEach((order) => {
          const price = parseFloat(order.px);
          const amount = parseFloat(order.sz);
          orderBook.bids.push({ price, amount, total: 0 });
        });

        sellSide.forEach((order) => {
          const price = parseFloat(order.px);
          const amount = parseFloat(order.sz);
          orderBook.asks.push({ price, amount, total: 0 });
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

      this.subscribe({ type: "l2Book", coin: symbol });
    };

    waitConnectAndSubscribe();
  }

  unlistenOrderBook(symbol: string) {
    const orderBookTopic = `orderbook.500.${symbol}`;
    const timeout = this.orderBookTimeouts.get(orderBookTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.orderBookTimeouts.delete(orderBookTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.unsubscribe({ type: "l2Book", coin: symbol });
    }

    delete this.messageHandlers[orderBookTopic];
    this.orderBookTopics.delete(orderBookTopic);
  }

  onOpen = () => {
    this.parent.log(`HyperLiquid Public WebSocket opened`);
    this.ping();

    for (const ticker in this.parent.memory.public.tickers) {
      this.subscribe({ type: "activeAssetCtx", coin: ticker });
    }
  };

  ping = () => {
    this.pingAt = performance.now();
    this.send({ method: "ping" });
  };

  onMessage = (event: MessageEvent) => {
    const json = tryParse<{ channel: string; data: any }>(event.data);
    if (!json) return;

    for (const key in this.messageHandlers) {
      this.messageHandlers[key](json);
    }
  };

  handlePong = (json: Record<string, any>) => {
    if (json.channel === "pong") {
      const latency = (performance.now() - this.pingAt) / 2;

      this.parent.emitChanges([
        { type: "update", path: "public.latency", value: latency },
      ]);

      this.pingTimeout = setTimeout(() => {
        this.ping();
      }, 10_000);
    }
  };

  handleActiveAssets = (json: Record<string, any>) => {
    if (json.channel === "activeAssetCtx") {
      const {
        data: { coin, ctx },
      } = json as HLActiveAssetCtxWs;

      if (coin in this.parent.memory.public.tickers) {
        const ticker = this.parent.memory.public.tickers[coin];
        const t: Partial<Ticker> & { symbol: string } = {
          symbol: coin,
        };

        const last = ctx.midPx ? parseFloat(ctx.midPx) : ticker.last;

        if (ctx.funding) t.fundingRate = parseFloat(ctx.funding);
        if (ctx.openInterest) t.openInterest = parseFloat(ctx.openInterest);
        if (ctx.midPx) t.last = parseFloat(ctx.midPx);
        if (ctx.oraclePx) t.index = parseFloat(ctx.oraclePx);
        if (ctx.markPx) t.mark = parseFloat(ctx.markPx);
        if (ctx.dayNtlVlm) t.quoteVolume = parseFloat(ctx.dayNtlVlm);
        if (ctx.dayBaseVlm) t.volume = parseFloat(ctx.dayBaseVlm);

        if (ctx.impactPxs) {
          t.bid = parseFloat(ctx.impactPxs[0]);
          t.ask = parseFloat(ctx.impactPxs[1]);
        }

        if (ctx.prevDayPx) {
          const prevDay = parseFloat(ctx.prevDayPx);
          t.percentage = ((last - prevDay) / prevDay) * 100;
        }

        t.nextFundingTime = +new Date(
          Math.ceil(Date.now() / 3600000) * 3600000,
        );

        this.parent.updateTickerDelta(t);
      }
    }
  };

  onClose = () => {
    this.parent.error(`HyperLiquid WebSocket closed`);

    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  };

  send = (data: Record<string, any>) => {
    if (!this.isStopped) this.ws?.send(JSON.stringify(data));
  };

  subscribe = (subscription: Record<string, string> & { type: string }) => {
    this.send({ method: "subscribe", subscription });
  };

  unsubscribe = (subscription: Record<string, string> & { type: string }) => {
    this.send({ method: "unsubscribe", subscription });
  };

  stop = () => {
    this.isStopped = true;

    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  };
}
