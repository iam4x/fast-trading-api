import type { OkxWorker } from "./okx.worker";
import { INTERVAL } from "./okx.config";

import type { Candle, Timeframe } from "~/types/lib.types";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { tryParse } from "~/utils/try-parse.utils";

export class OkxWsBusiness {
  parent: OkxWorker;

  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  messageHandlers: Record<string, (data: Record<string, any>) => void> = {};

  ohlcvTopics = new Set<string>();
  ohlcvTimeouts = new Map<string, NodeJS.Timeout>();

  constructor({ parent }: { parent: OkxWorker }) {
    this.parent = parent;
    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_BUSINESS_URL!);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = () => {
    this.parent.log(`OKX Business Websocket Opened`);
  };

  onMessage = (event: MessageEvent) => {
    const json = tryParse<Record<string, any>>(event.data);
    if (!json) return;

    for (const key in this.messageHandlers) {
      this.messageHandlers[key](json);
    }
  };

  listenOHLCV = ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) => {
    const interval = INTERVAL[timeframe];
    const ohlcvTopic = `ohlcv.${symbol}.${interval}`;

    if (this.ohlcvTopics.has(ohlcvTopic)) return;
    this.ohlcvTopics.add(ohlcvTopic);

    this.messageHandlers[ohlcvTopic] = (json: Record<string, any>) => {
      if (
        json.arg.channel === `candle${interval}` &&
        json.arg.instId === this.parent.memory.public.tickers[symbol].id &&
        json.event !== "subscribe"
      ) {
        const candle: Candle = {
          symbol,
          timeframe,
          timestamp: parseInt(json.data[0][0], 10) / 1000,
          open: parseFloat(json.data[0][1]),
          high: parseFloat(json.data[0][2]),
          low: parseFloat(json.data[0][3]),
          close: parseFloat(json.data[0][4]),
          volume: parseFloat(json.data[0][7]),
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

      this.send({
        op: "subscribe",
        args: [
          {
            channel: `candle${interval}`,
            instId: this.parent.memory.public.tickers[symbol].id,
          },
        ],
      });
    };

    waitConnectAndSubscribe();
  };

  send = (data: string | Record<string, any>) => {
    if (!this.isStopped) {
      this.ws?.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  };

  onClose = () => {
    this.parent.error(`OKX Business Websocket Closed`);

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  stop = () => {
    this.isStopped = true;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };
}
