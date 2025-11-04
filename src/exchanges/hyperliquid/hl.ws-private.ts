import { ReconnectingWebSocket } from "@iam4x/reconnecting-websocket";

import type { HyperLiquidWorker } from "./hl.worker";
import {
  formatHLOrder,
  formatHLOrderUpdate,
  mapHLOrder,
  mapHLUserAccount,
} from "./hl.utils";
import type {
  HLAction,
  HLPostCancelOrdersResponse,
  HLPostPlaceOrdersResponse,
  HLUserAccount,
  HLUserFillEvent,
  HLUserOrder,
} from "./hl.types";

import {
  OrderSide,
  PositionSide,
  type Account,
  type Order,
  type PlaceOrderOpts,
  type PlacePositionStopOpts,
  type Position,
  type UpdateOrderOpts,
} from "~/types/lib.types";
import { chunk } from "~/utils/chunk.utils";
import { genId, genIntId } from "~/utils/gen-id.utils";
import { sleep } from "~/utils/sleep.utils";
import { signHLAction } from "~/utils/signer.utils";
import { tryParse } from "~/utils/try-parse.utils";

type Data = {
  id: number;
  action: HLAction;
};

export class HyperLiquidWsPrivate {
  parent: HyperLiquidWorker;
  account: Account;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  isStopped = false;
  isListening = false;

  pendingRequests = new Map<number, (data: any) => void>();

  queue: { payload: Data; consume: number }[] = [];
  isProcessing = false;
  rateLimit = 10;
  queueInterval = 1000 / this.rateLimit;

  get memory() {
    return this.parent.memory.private[this.account.id];
  }

  constructor({
    parent,
    account,
  }: {
    parent: HyperLiquidWorker;
    account: Account;
  }) {
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

  onOpen = () => {
    this.parent.log(
      `HyperLiquid Private WebSocket Opened for account [${this.account.id}]`,
    );

    this.ping();

    this.subscribe({
      type: "webData2",
      user: this.account.vaultAddress ?? this.account.apiKey,
    });

    this.subscribe({
      type: "userFills",
      user: this.account.vaultAddress ?? this.account.apiKey,
    });
  };

  onMessage = (event: MessageEvent) => {
    // We don't want to handle messages before fetching initial data
    if (!this.isListening) return;

    const json = tryParse<{ channel: string; data: any }>(event.data);
    if (!json) return;

    if (
      json.channel === "userFills" &&
      json.data.isSnapshot !== true &&
      json.data.fills.length > 0
    ) {
      this.onUserFills(json.data.fills);
    }

    if (json.channel === "webData2") {
      this.onWebData2(json.data);
    }

    if (json.channel === "post" && json.data.id) {
      const callback = this.pendingRequests.get(json.data.id);

      if (callback) {
        callback(json);
        this.pendingRequests.delete(json.data.id);
      }

      // This is when the signature is invalid
      // HyperLiquid will reply with a weird error that doesn't help
      if (json?.data?.response?.payload?.status === "err") {
        this.parent.error(`[${this.account.id}] HyperLiquid signature error`);
        this.parent.error(json.data.response.payload.response);
      }
    }
  };

  onUserFills = (fills: HLUserFillEvent[]) => {
    const notifLength = this.memory.notifications.length;
    const fillsLength = this.memory.fills.length;

    const changes = fills.flatMap((e, idx) => [
      {
        type: "update",
        path: `private.${this.account.id}.notifications.${notifLength + idx}`,
        value: {
          id: genId(),
          accountId: this.account.id,
          type: "order_fill",
          data: {
            id: e.oid,
            symbol: e.coin,
            side: e.side === "A" ? OrderSide.Sell : OrderSide.Buy,
            price: parseFloat(e.px),
            amount: parseFloat(e.sz),
          },
        },
      } as const,
      {
        type: "update",
        path: `private.${this.account.id}.fills.${fillsLength + idx}`,
        value: {
          symbol: e.coin,
          side: e.side === "A" ? OrderSide.Sell : OrderSide.Buy,
          price: parseFloat(e.px),
          amount: parseFloat(e.sz),
          timestamp: Date.now(),
        },
      } as const,
    ]);

    this.parent.emitChanges(changes);
  };

  onWebData2 = ({
    clearinghouseState,
    openOrders,
  }: {
    openOrders: HLUserOrder[];
    clearinghouseState: HLUserAccount;
  }) => {
    const { positions, balance } = mapHLUserAccount({
      accountId: this.account.id,
      data: clearinghouseState,
    });

    const balanceChange = {
      type: "update",
      path: `private.${this.account.id}.balance`,
      value: balance,
    } as const;

    const ordersChange = {
      type: "update",
      path: `private.${this.account.id}.orders`,
      value: openOrders.map((o) =>
        mapHLOrder({
          accountId: this.account.id,
          order: o,
        }),
      ),
    } as const;

    const positionsChange = {
      type: "update",
      path: `private.${this.account.id}.positions`,
      value: positions,
    } as const;

    const metadataChanges = positions.flatMap((p) => [
      {
        type: "update",
        path: `private.${this.account.id}.metadata.leverage.${p.symbol}`,
        value: p.leverage,
      } as const,
      {
        type: "update",
        path: `private.${this.account.id}.metadata.hedgedPosition.${p.symbol}`,
        value: p.isHedged ?? false,
      } as const,
    ]);

    this.parent.emitChanges([
      balanceChange,
      ordersChange,
      positionsChange,
      ...metadataChanges,
    ]);
  };

  ping = () => {
    this.interval = setInterval(() => {
      this.send({ method: "ping" });
    }, 10_000);
  };

  placePositionStop = ({
    position,
    stop,
    priority = false,
  }: {
    position: Position;
    stop: PlacePositionStopOpts;
    priority?: boolean;
  }) => {
    const reqId = genIntId();

    return new Promise<HLPostPlaceOrdersResponse>(async (resolve) => {
      this.pendingRequests.set(reqId, (json: HLPostPlaceOrdersResponse) => {
        if (json?.data?.response?.payload?.status === "ok") {
          json.data.response.payload.response.data.statuses.forEach(
            (status) => {
              // Special case where HL reply with "waitingForTrigger"
              // This is when we place stop loss / take profit on the position
              if (typeof status === "string") return;

              if ("error" in status) {
                this.parent.error(
                  `[${this.account.id}] HyperLiquid place order error`,
                );
                this.parent.error(status.error);
              }
            },
          );
        }

        resolve(json);
      });

      const stopOrder = {
        symbol: position.symbol,
        type: stop.type,
        side:
          position.side === PositionSide.Long ? OrderSide.Sell : OrderSide.Buy,
        amount: 0, // HL needs size 0 for binding to stop to the position
        price: stop.price,
        reduceOnly: true,
      };

      const action = {
        type: "order",
        orders: [
          formatHLOrder({
            order: stopOrder,
            tickers: this.parent.memory.public.tickers,
            markets: this.parent.memory.public.markets,
          }),
        ],
        grouping: "positionTpsl",
      } as HLAction;

      if (
        this.parent.config.options?.builderAddress &&
        this.parent.config.options?.builderFees
      ) {
        (action as any).builder = {
          b: this.parent.config.options.builderAddress.toLowerCase(),
          f: this.parent.config.options.builderFees,
        };
      }

      this.enqueueSend({
        payload: { id: reqId, action },
        priority,
      });
    });
  };

  placeOrders = ({
    orders,
    priority = false,
  }: {
    orders: PlaceOrderOpts[];
    priority?: boolean;
  }) => {
    const orderIds: Array<Order["id"]> = [];
    const postOrders = orders.map((o) =>
      formatHLOrder({
        order: o,
        tickers: this.parent.memory.public.tickers,
        markets: this.parent.memory.public.markets,
      }),
    );

    return new Promise<Array<Order["id"]>>(async (resolve) => {
      const batches = chunk(postOrders, 20);
      const responses: any[] = [];

      for (const batch of batches) {
        const reqId = genIntId();

        this.pendingRequests.set(reqId, (json: HLPostPlaceOrdersResponse) => {
          if (json?.data?.response?.payload?.status === "ok") {
            json.data.response.payload.response.data.statuses.forEach(
              (status) => {
                // Special case where HL reply with "waitingForTrigger"
                // This is when we place stop loss / take profit on the position
                if (typeof status === "string") return;

                if ("error" in status) {
                  this.parent.error(
                    `[${this.account.id}] HyperLiquid place order error`,
                  );
                  this.parent.error(status.error);
                }

                if ("resting" in status) {
                  orderIds.push(status.resting.oid);
                }

                if ("filled" in status) {
                  orderIds.push(status.filled.oid);
                }
              },
            );
          }

          responses.push(json);

          if (responses.length === batches.length) {
            resolve(orderIds);
          }
        });

        const hasStopOrders = batch.some((o) => "trigger" in o.t);
        const action = {
          type: "order",
          orders: batch,
          grouping: hasStopOrders ? "normalTpsl" : "na",
        } as HLAction;

        if (
          this.parent.config.options?.builderAddress &&
          this.parent.config.options?.builderFees &&
          !this.account.vaultAddress
        ) {
          (action as any).builder = {
            b: this.parent.config.options.builderAddress.toLowerCase(),
            f: this.parent.config.options.builderFees,
          };
        }

        this.enqueueSend({
          payload: { id: reqId, action },
          priority,
        });
      }
    });
  };

  cancelOrders = ({
    orders,
    priority = false,
  }: {
    orders: Order[];
    priority?: boolean;
  }) => {
    return new Promise(async (resolve) => {
      const batches = chunk(orders, 20);
      const responses: any[] = [];

      for (const batch of batches) {
        const reqId = genIntId();

        this.pendingRequests.set(reqId, (json: HLPostCancelOrdersResponse) => {
          responses.push(json);

          if (responses.length === batches.length) {
            resolve(responses);
          }
        });

        const action = {
          type: "cancel" as const,
          cancels: batch.map((o) => ({
            a: this.parent.memory.public.markets[o.symbol].id as number,
            o: o.id as number,
          })),
        };

        this.enqueueSend({
          payload: { id: reqId, action },
          priority,
        });
      }
    });
  };

  updateOrders = ({
    updates,
    priority = false,
  }: {
    updates: UpdateOrderOpts[];
    priority?: boolean;
  }) => {
    return new Promise(async (resolve) => {
      const batches = chunk(updates, 20);
      const responses: any[] = [];

      for (const batch of batches) {
        const reqId = genIntId();

        this.pendingRequests.set(reqId, (json: any) => {
          responses.push(json);

          if (responses.length === batches.length) {
            resolve(json);
          }
        });

        const action = {
          type: "batchModify" as const,
          modifies: batch.map((u) =>
            formatHLOrderUpdate({
              update: u,
              tickers: this.parent.memory.public.tickers,
              markets: this.parent.memory.public.markets,
            }),
          ),
        } as HLAction;

        this.enqueueSend({
          payload: { id: reqId, action },
          priority,
        });
      }
    });
  };

  setLeverage = async ({
    symbol,
    leverage,
    priority = false,
  }: {
    symbol: string;
    leverage: number;
    priority?: boolean;
  }) => {
    return new Promise(async (resolve) => {
      const reqId = genIntId();

      this.pendingRequests.set(reqId, (json: any) => {
        resolve(json);
      });

      const action = {
        type: "updateLeverage" as const,
        asset: this.parent.memory.public.markets[symbol].id as number,
        isCross: true,
        leverage,
      } as HLAction;

      this.enqueueSend({
        payload: { id: reqId, action },
        priority,
      });
    });
  };

  onClose = () => {
    this.parent.error(
      `HyperLiquid Private Websocket Closed for account [${this.account.id}]`,
    );

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  enqueueSend = ({
    payload,
    consume = 1,
    priority = false,
  }: {
    payload: Data;
    consume?: number;
    priority?: boolean;
  }) => {
    if (priority) {
      this.queue.unshift({ payload, consume });
    } else {
      this.queue.push({ payload, consume });
    }

    if (!this.isProcessing) {
      this.processQueue();
    }
  };

  processQueue = async () => {
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();

      if (item) {
        const { payload, consume } = item;

        const nonce = Date.now();
        const signature = await signHLAction({
          privateKey: this.account.apiSecret,
          vaultAddress: this.account.vaultAddress,
          action: payload.action,
          nonce,
        });

        const requestPayload: Record<string, any> = {
          action: payload.action,
          nonce,
          signature,
        };

        if (this.account.vaultAddress) {
          requestPayload.vaultAddress = this.account.vaultAddress;
        }

        this.send({
          method: "post",
          id: payload.id,
          request: {
            type: "action",
            payload: requestPayload,
          },
        });

        await sleep(this.queueInterval * consume);
      }
    }

    this.isProcessing = false;
  };

  send = (data: Record<string, any>) => {
    if (!this.isStopped) this.ws?.send(JSON.stringify(data));
  };

  subscribe = (subscription: Record<string, string> & { type: string }) => {
    this.send({ method: "subscribe", subscription });
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
