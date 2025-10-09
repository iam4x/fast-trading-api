import type { OkxWorker } from "./okx.worker";
import { tickerSymbolFromId } from "./okx.utils";

import { mapObj } from "~/utils/map-obj.utils";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { toUSD } from "~/utils/to-usd.utils";
import { tryParse } from "~/utils/try-parse.utils";

export class OkxWsPublic {
  parent: OkxWorker;

  isStopped = false;
  pingAt = 0;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (json: Record<string, any>) => void> = {};

  orderBookTopics = new Set<string>();
  orderBookTimeouts = new Map<string, NodeJS.Timeout>();

  ohlcvTopics = new Set<string>();
  ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

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

    for (const [channel, handler] of Object.entries(this.messageHandlers)) {
      if (
        event.data.includes(`channel":"${channel}`) &&
        !event.data.includes('event":"subscribe"')
      ) {
        const json = tryParse<Record<string, any>>(event.data);
        if (json) handler(json);
        break;
      }
    }
  };

  handleTickers = ({ data: [update] }: Record<string, any>) => {
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

  handleMarkPrice = ({ data: [update] }: Record<string, any>) => {
    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      mark: parseFloat(update.markPx),
    });
  };

  handleIndexTickers = ({ data: [update] }: Record<string, any>) => {
    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      index: parseFloat(update.idxPx),
    });
  };

  handleOpenInterest = ({ data: [update] }: Record<string, any>) => {
    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      openInterest: parseFloat(update.oiCcy),
    });
  };

  handleFundingRate = ({ data: [update] }: Record<string, any>) => {
    const tickerSymbol = tickerSymbolFromId(update.instId);
    this.parent.updateTickerDelta({
      symbol: tickerSymbol,
      fundingRate: parseFloat(update.fundingRate),
    });
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
