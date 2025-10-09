import { bybitWebsocketAuth } from "./bybit.api";
import { BROKER_ID, RECV_WINDOW } from "./bybit.config";
import type {
  BybitCancelOrderBatchResponse,
  BybitPlaceOrderBatchResponse,
  BybitPlaceOrderOpts,
  BybitUpdateOrderBatchResponse,
} from "./bybit.types";
import type { BybitWorker } from "./bybit.worker";
import { getHedgedOrderPositionIdx } from "./bybit.utils";

import { chunk } from "~/utils/chunk.utils";
import type { Account, Order } from "~/types/lib.types";
import { genId } from "~/utils/gen-id.utils";
import { adjust } from "~/utils/safe-math.utils";
import { sleep } from "~/utils/sleep.utils";
import { ReconnectingWebSocket } from "~/utils/reconnecting-websocket.utils";
import { tryParse } from "~/utils/try-parse.utils";

type Data = {
  op: string;
  reqId?: string;
  header?: Record<string, string>;
  args?: string[] | Record<string, any>[];
};

export class BybitWsTrading {
  account: Account;
  parent: BybitWorker;
  pingAt = 0;

  isStopped = false;

  ws: ReconnectingWebSocket | null = null;
  interval: NodeJS.Timeout | null = null;

  pendingRequests = new Map<string, (data: any) => void>();

  queue: { payload: Data; consume: number }[] = [];
  isProcessing = false;
  rateLimit = 10;
  queueInterval = 1000 / this.rateLimit;

  constructor({ account, parent }: { account: Account; parent: BybitWorker }) {
    this.account = account;
    this.parent = parent;
    this.listenWebsocket();
  }

  listenWebsocket = () => {
    this.ws = new ReconnectingWebSocket(this.parent.config.WS_TRADE_URL!);
    this.ws.addEventListener("open", this.onOpen);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("close", this.onClose);
  };

  onOpen = async () => {
    this.parent.log(
      `Bybit Trading Websocket Opened for account [${this.account.id}]`,
    );

    await this.auth();
    this.ping();
  };

  auth = async () => {
    const authArgs = await bybitWebsocketAuth({
      key: this.account.apiKey,
      secret: this.account.apiSecret,
    });

    this.send({ op: "auth", args: authArgs });
  };

  ping = () => {
    this.pingAt = performance.now();
    this.send({ op: "ping" });
  };

  onPong = () => {
    const latency = (performance.now() - this.pingAt) / 2;

    this.parent.emitChanges([
      { type: "update", path: "public.latency", value: latency },
    ]);

    this.interval = setTimeout(() => {
      this.ping();
    }, 10_000);
  };

  onMessage = (event: MessageEvent) => {
    if (event.data.includes("pong")) {
      this.onPong();
      return;
    }

    if (event.data.includes("reqId")) {
      const json = tryParse<{ reqId: string }>(event.data);
      if (!json) return;

      const callback = this.pendingRequests.get(json.reqId);

      if (callback) {
        callback(json);
        this.pendingRequests.delete(json.reqId);
      }
    }
  };

  onClose = () => {
    this.parent.error(
      `Bybit Trading Websocket Closed for account [${this.account.id}]`,
    );

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  };

  send = (data: Data) => {
    if (!this.isStopped) this.ws?.send(JSON.stringify(data));
  };

  placeOrders = ({
    orders,
    priority = false,
    retry = true,
  }: {
    orders: BybitPlaceOrderOpts[];
    priority?: boolean;
    retry?: boolean;
  }) => {
    return new Promise<string[]>((resolve) => {
      const batches = chunk(orders, 10);

      const responses: BybitPlaceOrderBatchResponse["data"]["list"] = [];
      const toRetry: BybitPlaceOrderOpts[] = [];

      for (const batch of batches) {
        const reqId = genId();

        this.pendingRequests.set(
          reqId,
          async (data: BybitPlaceOrderBatchResponse) => {
            data.retExtInfo.list.forEach((res, idx) => {
              if (
                res.code === 10001 &&
                res.msg === "position idx not match position mode"
              ) {
                const order = batch[idx];
                const positionIdx = getHedgedOrderPositionIdx(order);

                this.parent.emitChanges([
                  {
                    type: "update",
                    path: `private.${this.account.id}.metadata.hedgedPosition.${order.symbol}`,
                    value: true,
                  },
                ]);

                toRetry.push({ ...order, positionIdx });
                return;
              }

              if (res.code !== 0) {
                this.parent.error(
                  `[${this.account.id}] Bybit place order error: ${res.msg}`,
                );
              }
            });

            responses.push(...data.data.list);

            if (responses.length === orders.length) {
              const orderIds: string[] = [];

              if (toRetry.length > 0 && retry) {
                const retriedOrderIds = await this.placeOrders({
                  orders: toRetry,
                  priority,
                  retry: false,
                });

                orderIds.push(...retriedOrderIds);
              }

              orderIds.push(
                ...responses
                  .filter((o) => o.orderId !== "")
                  .map((o) => o.orderId),
              );

              resolve(orderIds);
            }
          },
        );

        this.enqueueSend({
          consume: batch.length,
          priority,
          payload: {
            op: "order.create-batch",
            reqId,
            args: [{ category: "linear", request: batch }],
          },
        });
      }
    });
  };

  updateOrders = ({
    updates,
    priority = false,
  }: {
    updates: {
      order: Order;
      update: { price: number } | { amount: number };
    }[];
    priority?: boolean;
  }) => {
    return new Promise((resolve) => {
      const batches = chunk(updates, 10);
      const responses: BybitUpdateOrderBatchResponse[] = [];

      for (const batch of batches) {
        const reqId = genId();

        this.pendingRequests.set(
          reqId,
          (data: BybitUpdateOrderBatchResponse) => {
            data.retExtInfo.list.forEach((res) => {
              if (res.code !== 0) {
                this.parent.error(
                  `[${this.account.id}] Bybit update order error: ${res.msg}`,
                );
              }
            });

            responses.push(data);

            if (responses.length === batches.length) {
              resolve(responses);
            }
          },
        );

        this.enqueueSend({
          consume: batch.length,
          priority,
          payload: {
            op: "order.amend-batch",
            reqId,
            args: [
              {
                category: "linear",
                request: batch.map(({ order, update }) => {
                  const market =
                    this.parent.memory.public.markets[order.symbol];

                  const amendedOrder: Record<string, string | number> = {
                    symbol: order.symbol,
                    orderId: order.id,
                  };

                  if ("price" in update) {
                    amendedOrder["price"] = adjust(
                      update.price,
                      market.precision.price,
                    ).toString();
                  }

                  if ("amount" in update) {
                    amendedOrder["qty"] = adjust(
                      update.amount,
                      market.precision.amount,
                    ).toString();
                  }

                  return amendedOrder;
                }),
              },
            ],
          },
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
    return new Promise((resolve) => {
      const batches = chunk(orders, 10);

      const responses: BybitCancelOrderBatchResponse[] = [];
      const toRemove: Order[] = [];

      for (const batch of batches) {
        const reqId = genId();

        this.pendingRequests.set(
          reqId,
          (data: BybitCancelOrderBatchResponse) => {
            data.retExtInfo.list.forEach((res, idx) => {
              if (
                res.code === 110001 &&
                res.msg === "order not exists or too late to cancel"
              ) {
                toRemove.push(batch[idx]);
                return;
              }

              if (res.code !== 0) {
                this.parent.error(
                  `[${this.account.id}] Bybit cancel order error: ${res.msg}`,
                );
              }
            });

            responses.push(data);

            if (responses.length === batches.length) {
              const accountOrders =
                this.parent.memory.private[this.account.id].orders;

              this.parent.emitChanges(
                toRemove.map(({ id }) => ({
                  type: "removeArrayElement",
                  path: `private.${this.account.id}.orders` as const,
                  index: accountOrders.findIndex((o) => o.id === id),
                })),
              );

              resolve(responses);
            }
          },
        );

        this.enqueueSend({
          consume: batch.length,
          priority,
          payload: {
            op: "order.cancel-batch",
            reqId,
            args: [
              {
                category: "linear",
                request: batch.map((o) => ({
                  symbol: o.symbol,
                  orderId: o.id,
                })),
              },
            ],
          },
        });
      }
    });
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

        this.send({
          ...payload,
          header: {
            "X-BAPI-TIMESTAMP": `${Date.now()}`,
            "X-BAPI-RECV-WINDOW": `${RECV_WINDOW}`,
            Referer: BROKER_ID,
          },
        });

        await sleep(this.queueInterval * consume);
      }
    }

    this.isProcessing = false;
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
