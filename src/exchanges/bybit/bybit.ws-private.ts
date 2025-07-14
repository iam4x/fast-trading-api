import { bybitWebsocketAuth } from "./bybit.api";
import type {
  BybitBalance,
  BybitOrder,
  BybitWebsocketPosition,
} from "./bybit.types";
import { mapBybitBalance, mapBybitPosition } from "./bybit.utils";
import type { BybitWorker } from "./bybit.worker";

import { partition } from "~/utils/partition.utils";
import { uniqBy } from "~/utils/uniq-by.utils";
import { PositionSide, type Account } from "~/types/lib.types";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { tryParse } from "~/utils/try-parse.utils";

export class BybitWsPrivate {
  parent: BybitWorker;
  isStopped = false;
  isListening = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  account: Account;

  constructor({ parent, account }: { parent: BybitWorker; account: Account }) {
    this.parent = parent;
    this.account = account;

    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_PRIVATE_URL);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  startListening = () => {
    // We simply toggle handle message from websocket
    // because we don't want to handle messages before fetching initial data
    // but we still want to initiate the connection
    this.isListening = true;
  };

  onOpen = async () => {
    this.parent.log(
      `Bybit Private Websocket Opened for account [${this.account.id}]`,
    );

    await this.auth();
    this.ping();
    this.send({ op: "subscribe", args: ["position.linear"] });
    this.send({ op: "subscribe", args: ["order.linear"] });
    this.send({ op: "subscribe", args: ["wallet"] });
  };

  auth = async () => {
    const authArgs = await bybitWebsocketAuth({
      key: this.account.apiKey,
      secret: this.account.apiSecret,
    });

    this.send({ op: "auth", args: authArgs });
  };

  ping = () => {
    this.interval = setInterval(() => {
      this.send({ op: "ping" });
    }, 10_000);
  };

  onMessage = (event: MessageEvent) => {
    // We don't want to handle messages before fetching initial data
    if (!this.isListening) return;

    const parsed = tryParse<{ topic: string; data: any }>(event.data);
    if (!parsed) return;

    if (parsed.topic === "position.linear") {
      const data = parsed.data as BybitWebsocketPosition[];
      this.onPositionTopic(data);
      return;
    }

    if (parsed.topic === "wallet") {
      const data = parsed.data as BybitBalance[];
      this.parent.updateAccountBalance({
        accountId: this.account.id,
        balance: mapBybitBalance(data[0]),
      });
      return;
    }

    if (parsed.topic === "order.linear") {
      const data = parsed.data as BybitOrder[];
      this.parent.updateAccountOrders({
        accountId: this.account.id,
        bybitOrders: data,
      });
      return;
    }
  };

  onPositionTopic = (data: BybitWebsocketPosition[]) => {
    // I don't know why but bybit sends empty positions with side ""
    // see: https://bybit-exchange.github.io/docs/v5/websocket/private/position
    const [toRemoveClosed, toUpdate] = partition(data, (p) => p.side === "");

    // We can have a case where user closees a side of a position when placing
    // an order on the opposite side bigger than the current position
    const toRemoveOppositeSide = toUpdate.filter((p) => p.positionIdx === 0);
    const toRemove: Array<{ side: PositionSide; symbol: string }> = [];

    if (toRemoveOppositeSide.length > 0) {
      toRemove.push(
        ...toRemoveOppositeSide.map(({ side, symbol }) => ({
          side: side === "Buy" ? PositionSide.Short : PositionSide.Long,
          symbol,
        })),
      );
    }

    if (toRemoveClosed.length > 0) {
      toRemove.push(
        ...toRemoveClosed.flatMap(({ positionIdx: pIdx, symbol }) => {
          if (pIdx === 0) {
            return [
              { side: PositionSide.Long, symbol },
              { side: PositionSide.Short, symbol },
            ];
          }

          const side = pIdx === 1 ? PositionSide.Long : PositionSide.Short;
          return [{ side, symbol }];
        }),
      );
    }

    if (toRemove.length > 0) {
      this.parent.removeAccountPositions({
        accountId: this.account.id,
        positions: uniqBy(toRemove, (p) => p.side + p.symbol),
      });
    }

    if (toUpdate.length > 0) {
      this.parent.updateAccountPositions({
        accountId: this.account.id,
        positions: toUpdate
          .filter((p) => p.symbol in this.parent.memory.public.markets)
          .map((p) => {
            const position = mapBybitPosition({
              position: p,
              accountId: this.account.id,
            });

            // we need to calculate ourself the notional value
            // because bybit doesn't sends the up-to-date value based on ticker price
            const notional =
              position.contracts *
              this.parent.memory.public.tickers[p.symbol].last;

            return { ...position, notional };
          }),
      });
    }
  };

  onClose = () => {
    this.parent.error(
      `Bybit Private Websocket Closed for account [${this.account.id}]`,
    );

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
