import type { OkxWorker } from "./okx.worker";
import { tickerSymbolFromId } from "./okx.utils";

import { mapObj } from "~/utils/map-obj.utils";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { toUSD } from "~/utils/to-usd.utils";
import { tryParse } from "~/utils/try-parse.utils";
import { multiply } from "~/utils/safe-math.utils";
import { calcOrderBookTotal, sortOrderBook } from "~/utils/orderbook.utils";
import type { OrderBook } from "~/types/lib.types";

export class OkxWsPublic {
  parent: OkxWorker;

  isStopped = false;
  pingAt = 0;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (json: Record<string, any>) => void> = {};

  orderBookTopics = new Set<string>();
  orderBookTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent }: { parent: OkxWorker }) {
    this.parent = parent;

    this.messageHandlers.tickers = this.handleTickers;
    this.messageHandlers["mark-price"] = this.handleMarkPrice;
    this.messageHandlers["index-tickers"] = this.handleIndexTickers;
    this.messageHandlers["open-interest"] = this.handleOpenInterest;
    this.messageHandlers["funding-rate"] = this.handleFundingRate;

    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_PUBLIC_URL);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = () => {
    this.parent.log(`OKX Public Websocket Opened`);
    this.ping();

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.tickers, (_, m) => ({
        channel: "tickers",
        instId: m.id,
      })),
    });

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.tickers, (_, m) => ({
        channel: "mark-price",
        instId: m.id,
      })),
    });

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.tickers, (_, m) => ({
        channel: "index-tickers",
        instId: (m.id as string).replace("-SWAP", ""),
      })),
    });

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.tickers, (_, m) => ({
        channel: "open-interest",
        instId: m.id,
      })),
    });

    this.send({
      op: "subscribe",
      args: mapObj(this.parent.memory.public.tickers, (_, m) => ({
        channel: "funding-rate",
        instId: m.id,
      })),
    });
  };

  ping = () => {
    this.pingAt = performance.now();
    this.send("ping");
  };

  onMessage = (event: MessageEvent) => {
    if (event.data === "pong") {
      const latency = (performance.now() - this.pingAt) / 2;

      this.parent.emitChanges([
        { type: "update", path: "public.latency", value: latency },
      ]);

      this.interval = setTimeout(() => {
        this.ping();
      }, 10_000);

      return;
    }

    const json = tryParse<Record<string, any>>(event.data);
    if (!json || json.event === "subscribe") return;

    for (const key in this.messageHandlers) {
      this.messageHandlers[key](json);
    }
  };

  handleTickers = (json: Record<string, any>) => {
    if (json.arg.channel !== "tickers") return;

    const {
      data: [update],
    } = json;

    const tickerSymbol = tickerSymbolFromId(update.instId);
    const open = parseFloat(update.open24h);
    const last = parseFloat(update.last);
    const percentage = toUSD(((last - open) / open) * 100);

    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      bid: parseFloat(update.bidPx),
      ask: parseFloat(update.askPx),
      last,
      percentage,
      volume: parseFloat(update.volCcy24h),
      quoteVolume: parseFloat(update.vol24h),
    });
  };

  handleMarkPrice = (json: Record<string, any>) => {
    if (json.arg.channel !== "mark-price") return;

    const {
      data: [update],
    } = json;

    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      mark: parseFloat(update.markPx),
    });
  };

  handleIndexTickers = (json: Record<string, any>) => {
    if (json.arg.channel !== "index-tickers") return;

    const {
      data: [update],
    } = json;

    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      index: parseFloat(update.idxPx),
    });
  };

  handleOpenInterest = (json: Record<string, any>) => {
    if (json.arg.channel !== "open-interest") return;

    const {
      data: [update],
    } = json;

    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      openInterest: parseFloat(update.oiCcy),
    });
  };

  handleFundingRate = (json: Record<string, any>) => {
    if (json.arg.channel !== "funding-rate") return;

    const {
      data: [update],
    } = json;

    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      fundingRate: parseFloat(update.fundingRate),
    });
  };

  listenOrderBook = (symbol: string) => {
    const orderBook: OrderBook = { bids: [], asks: [] };
    const orderBookTopic = `orderbook.${symbol}`;

    if (this.orderBookTopics.has(orderBookTopic)) return;
    this.orderBookTopics.add(orderBookTopic);

    const market = this.parent.memory.public.markets[symbol];

    this.messageHandlers[orderBookTopic] = (json: Record<string, any>) => {
      if (json.arg.channel !== "books" || json.arg.instId !== market.id) {
        return;
      }

      if (json.action === "snapshot") {
        const snapshot = json.data[0];

        orderBook.bids = [];
        orderBook.asks = [];

        for (const key in snapshot) {
          if (key !== "asks" && key !== "bids") continue;

          const orders = snapshot[key];
          orders.forEach((order: [string, string, string, string]) => {
            orderBook[key].push({
              price: parseFloat(order[0]),
              amount: multiply(parseFloat(order[1]), market.precision.amount),
              total: 0,
            });
          });
        }
      }

      if (json.action === "update") {
        const update = json.data[0];

        for (const key in update) {
          if (key !== "asks" && key !== "bids") continue;

          for (const [rPrice, rAmount] of update[key]) {
            const price = parseFloat(rPrice);
            const amount = parseFloat(rAmount);

            const index = orderBook[key].findIndex((o) => o.price === price);

            if (amount === 0 && index !== -1) {
              orderBook[key].splice(index, 1);
              return;
            }

            if (amount !== 0) {
              if (index === -1) {
                orderBook[key].push({
                  price,
                  amount: multiply(amount, market.precision.amount),
                  total: 0,
                });
                return;
              }

              orderBook[key][index].amount = multiply(
                amount,
                market.precision.amount,
              );
            }
          }
        }
      }

      const ticker = this.parent.memory.public.tickers[symbol];
      const lastPrice = ticker.last ?? 0;

      orderBook.asks = orderBook.asks.filter((a) => a.price >= lastPrice);
      orderBook.bids = orderBook.bids.filter((b) => b.price <= lastPrice);

      sortOrderBook(orderBook);
      calcOrderBookTotal(orderBook);

      this.parent.emitOrderBook({ symbol, orderBook });
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
        op: "subscribe",
        args: [
          {
            channel: "books",
            instId: market.id,
          },
        ],
      });
    };

    waitConnectAndSubscribe();
  };

  unlistenOrderBook = (symbol: string) => {
    const orderBookTopic = `orderbook.${symbol}`;
    const timeout = this.orderBookTimeouts.get(orderBookTopic);

    if (timeout) {
      clearTimeout(timeout);
      this.orderBookTimeouts.delete(orderBookTopic);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        op: "unsubscribe",
        args: [
          {
            channel: "books",
            instId: this.parent.memory.public.tickers[symbol].id,
          },
        ],
      });
    }

    delete this.messageHandlers[orderBookTopic];
    this.orderBookTopics.delete(orderBookTopic);
  };

  onClose = () => {
    this.parent.error(`OKX Public Websocket Closed`);

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  send = (data: string | Record<string, any>) => {
    if (!this.isStopped) {
      this.ws?.send(typeof data === "string" ? data : JSON.stringify(data));
    }
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
