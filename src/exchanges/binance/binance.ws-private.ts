import type { BinanceWorker } from "./binance.worker";
import {
  fetchBinanceListenkey,
  refreshBinanceListenkey,
} from "./binance.resolver";
import { ORDER_SIDE, ORDER_TYPE, POSITION_SIDE } from "./binance.config";

import {
  OrderStatus,
  type Order,
  type Account,
  ExchangeName,
  PositionSide,
  type Position,
} from "~/types/lib.types";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { tryParse } from "~/utils/try-parse.utils";
import { genId, genIntId } from "~/utils/gen-id.utils";
import { subtract } from "~/utils/safe-math.utils";

export class BinanceWsPrivate {
  parent: BinanceWorker;
  account: Account;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;
  listenKeyInterval: NodeJS.Timeout | null = null;

  isStopped = false;

  constructor({
    parent,
    account,
  }: {
    parent: BinanceWorker;
    account: Account;
  }) {
    this.parent = parent;
    this.account = account;
    this.listenWebsocket();
  }

  listenWebsocket = async () => {
    const listenKey = await fetchBinanceListenkey({
      config: this.parent.config,
      account: this.account,
    });

    this.ws = new ReconnectingWebSocket(
      `${this.parent.config.WS_PRIVATE_URL}/${listenKey}`,
    );

    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = () => {
    this.parent.log(
      `Binance Private Websocket Opened for account [${this.account.id}]`,
    );

    this.ping();
  };

  onMessage = (event: MessageEvent) => {
    const json = tryParse<Record<string, any>>(event.data);
    if (!json) return;

    if (json?.e === "ACCOUNT_UPDATE") return this.handleAccountEvents(json);
    if (json?.e === "ORDER_TRADE_UPDATE") return this.handleOrderEvents(json);

    console.log(json);
  };

  onClose = () => {
    this.parent.error(
      `Binance Private Websocket Closed for account [${this.account.id}]`,
    );

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.listenKeyInterval) {
      clearInterval(this.listenKeyInterval);
      this.listenKeyInterval = null;
    }
  };

  ping = () => {
    this.interval = setInterval(() => {
      this.send({ id: genIntId(), method: "LIST_SUBSCRIPTIONS" });
    }, 10_000);

    this.listenKeyInterval = setInterval(
      () => {
        refreshBinanceListenkey({
          config: this.parent.config,
          account: this.account,
        });
      },
      1000 * 60 * 10,
    );
  };

  handleAccountEvents = (json: Record<string, any>) => {
    json.a.P.forEach((p: Record<string, any>) => {
      const symbol = p.s;

      // Positions are closed for this symbol
      if (p.pa === "0") {
        const positions =
          p.ps === "BOTH"
            ? [
                { side: PositionSide.Long, symbol },
                { side: PositionSide.Short, symbol },
              ]
            : [{ side: POSITION_SIDE[p.ps], symbol }];

        this.parent.removeAccountPositions({
          accountId: this.account.id,
          positions,
        });

        return;
      }

      if (p.pa !== "0") {
        const contracts = parseFloat(p.pa);

        const newPosition: Position = {
          exchange: ExchangeName.BINANCE,
          accountId: this.account.id,
          symbol,
          side: contracts > 0 ? PositionSide.Long : PositionSide.Short,
          entryPrice: parseFloat(p.ep),
          notional: Math.abs(contracts * parseFloat(p.ep)),
          leverage: 1, // WE DONT GET LEVERAGE FROM WS
          upnl: parseFloat(p.up),
          rpnl: 0,
          contracts: Math.abs(contracts),
          liquidationPrice: 0, // WE DONT GET LIQUIDATION PRICE FROM WS
          isHedged: p.ps !== "BOTH",
        };

        this.parent.updateAccountPositions({
          accountId: this.account.id,
          positions: [newPosition],
        });
      }
    });
  };

  handleOrderEvents = (json: Record<string, any>) => {
    if (json.o.X === "PARTIALLY_FILLED" || json.o.X === "FILLED") {
      this.parent.emitChanges([
        {
          type: "update",
          path: `private.${this.account.id}.notifications.${this.parent.memory.private[this.account.id].notifications.length}`,
          value: {
            id: genId(),
            accountId: this.account.id,
            type: "order_fill",
            data: {
              id: json.o.c,
              symbol: json.o.s,
              side: ORDER_SIDE[json.o.S],
              price: parseFloat(json.o.ap),
              amount: parseFloat(json.o.l),
            },
          },
        },
      ]);
    }

    if (json.o.X === "FILLED") {
      this.parent.emitChanges([
        {
          type: "update",
          path: `private.${this.account.id}.fills.${this.parent.memory.private[this.account.id].fills.length}`,
          value: {
            symbol: json.o.s,
            side: ORDER_SIDE[json.o.S],
            price: parseFloat(json.o.ap),
            amount: parseFloat(json.o.l),
            timestamp: json.T,
          },
        },
      ]);
    }

    if (json.o.X === "NEW") {
      const order: Order = {
        id: json.o.c,
        accountId: this.account.id,
        exchange: ExchangeName.BINANCE,
        status: OrderStatus.Open,
        symbol: json.o.s,
        type: ORDER_TYPE[json.o.ot],
        side: ORDER_SIDE[json.o.S],
        price: parseFloat(json.o.p) || parseFloat(json.o.sp),
        amount: parseFloat(json.o.q),
        filled: parseFloat(json.o.z),
        remaining: subtract(parseFloat(json.o.q), parseFloat(json.o.z)),
        reduceOnly: json.o.R || false,
        timestamp: json.o.T,
      };

      this.parent.emitChanges([
        {
          type: "update" as const,
          path: `private.${this.account.id}.orders.${this.parent.memory.private[this.account.id].orders.length}`,
          value: order,
        },
      ]);
    }

    if (
      json.o.X === "CANCELED" ||
      json.o.X === "FILLED" ||
      json.o.X === "EXPIRED"
    ) {
      const orderIdx = this.parent.memory.private[
        this.account.id
      ].orders.findIndex((o) => o.id === json.o.c);

      if (orderIdx !== -1) {
        this.parent.emitChanges([
          {
            type: "removeArrayElement",
            path: `private.${this.account.id}.orders` as const,
            index: orderIdx,
          },
        ]);
      }
    }
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

    if (this.listenKeyInterval) {
      clearInterval(this.listenKeyInterval);
      this.listenKeyInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  };
}
