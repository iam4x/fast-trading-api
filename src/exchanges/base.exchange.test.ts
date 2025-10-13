import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

import { BaseExchange } from "./base.exchange";

import {
  ExchangeName,
  type Account,
  OrderSide,
  OrderType,
} from "~/types/lib.types";
import { FastTradingApi } from "~/lib/fast-trading-api.lib";
import { DEFAULT_EXCHANGES_CONFIG } from "~/exchanges/exchanges.config";

const moduleMocker = {
  mocks: [] as Record<string, any>[],
  async mock(modulePath: string, renderMocks: () => Record<string, any>) {
    const original = { ...(await import(modulePath)) };
    mock.module(modulePath, () => ({ ...original, ...renderMocks() }));
    this.mocks.push({ clear: () => mock.module(modulePath, () => original) });
  },
  clear() {
    this.mocks.forEach((mockResult) => mockResult.clear());
    this.mocks = [];
  },
};

const mockWorker = (
  code = `
    self.postMessage({ type: "ready" });
    self.addEventListener("message", (event) => {
      if (event.data.requestId) {
        self.postMessage({ type: "response", requestId: event.data.requestId });
      }
    });
  `,
) => {
  const blob = new Blob([code], { type: "application/javascript" });
  const workerURL = URL.createObjectURL(blob);
  const worker = new Worker(workerURL);

  return {
    worker,
    terminate: () => {
      worker.terminate();
      URL.revokeObjectURL(workerURL);
    },
  };
};

describe("BaseExchange", () => {
  let genIdMock: ReturnType<typeof mock>;

  let worker: Worker;
  let terminate: () => void;
  let createWorker: ReturnType<typeof mock>;

  beforeEach(async () => {
    genIdMock = mock(() => "test");
    await moduleMocker.mock("~/utils/gen-id.utils.ts", () => ({
      genId: genIdMock,
    }));

    const { worker: w, terminate: t } = mockWorker();
    worker = w;
    terminate = t;
    createWorker = mock(() => w);
  });

  afterEach(() => {
    moduleMocker.clear();
    terminate();
  });

  test("should initialize correctly", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    expect(createWorker).toHaveBeenCalled();
    expect(exchange.name).toBe(ExchangeName.BYBIT);
  });

  test("should resolve start()", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    await exchange.start();

    terminate();
  });

  test("should stop()", () => {
    let terminateCalled = false;
    const originalTerminate = worker.terminate;
    worker.terminate = mock(() => {
      if (terminateCalled) {
        terminateCalled = true;
        originalTerminate();
      }
    });

    worker.postMessage = mock(() => {});
    worker.removeEventListener = mock(() => {});

    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    exchange.stop();

    expect(worker.terminate).toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worker.removeEventListener).toHaveBeenCalledWith(
      "message",
      exchange.onWorkerMessage,
    );

    terminate();
  });

  test("should handle addAccounts()", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const accounts: Account[] = [
      {
        id: "main",
        apiKey: "key",
        apiSecret: "secret",
        exchange: ExchangeName.BYBIT,
      },
    ];

    await exchange.addAccounts(accounts);

    terminate();
  });

  test("should handle fetchOHLCV", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    await exchange.fetchOHLCV({
      symbol: "BTCUSDT",
      timeframe: "1m",
      limit: 100,
    });

    terminate();
  });

  test("should handle placeOrders", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const originalPostMessage = worker.postMessage;
    worker.postMessage = mock((message: any) => {
      if (message.requestId) {
        // Simulate worker response
        setTimeout(() => {
          exchange.onWorkerMessage({
            data: { type: "response", requestId: message.requestId, data: [] },
          } as any);
        }, 0);
      }
    });

    await exchange.placeOrders({
      orders: [
        {
          symbol: "BTCUSDT",
          side: OrderSide.Buy,
          type: OrderType.Limit,
          amount: 0.1,
          price: 50000,
          reduceOnly: false,
        },
      ],
      accountId: "main",
      priority: true,
    });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "placeOrders",
        accountId: "main",
        priority: true,
        requestId: "test",
      }),
    );

    worker.postMessage = originalPostMessage;
    terminate();
  });

  test("should handle updateOrders", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const originalPostMessage = worker.postMessage;
    worker.postMessage = mock((message: any) => {
      if (message.requestId) {
        // Simulate worker response
        setTimeout(() => {
          exchange.onWorkerMessage({
            data: {
              type: "response",
              requestId: message.requestId,
              data: undefined,
            },
          } as any);
        }, 0);
      }
    });

    await exchange.updateOrders({
      updates: [
        {
          order: { id: "order1", symbol: "BTCUSDT" } as any,
          update: { price: 51000 },
        },
      ],
      accountId: "main",
      priority: true,
    });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateOrders",
        accountId: "main",
        priority: true,
        requestId: "test",
      }),
    );

    worker.postMessage = originalPostMessage;
    terminate();
  });

  test("should handle cancelOrders", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const originalPostMessage = worker.postMessage;
    worker.postMessage = mock((message: any) => {
      if (message.requestId) {
        // Simulate worker response
        setTimeout(() => {
          exchange.onWorkerMessage({
            data: {
              type: "response",
              requestId: message.requestId,
              data: undefined,
            },
          } as any);
        }, 0);
      }
    });

    await exchange.cancelOrders({
      orderIds: ["order1", "order2"],
      accountId: "main",
      priority: true,
    });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancelOrders",
        orderIds: ["order1", "order2"],
        accountId: "main",
        priority: true,
        requestId: "test",
      }),
    );

    worker.postMessage = originalPostMessage;
    terminate();
  });

  test("should handle fetchPositionMetadata", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const originalPostMessage = worker.postMessage;
    worker.postMessage = mock((message: any) => {
      if (message.requestId) {
        // Simulate worker response
        setTimeout(() => {
          exchange.onWorkerMessage({
            data: {
              type: "response",
              requestId: message.requestId,
              data: { leverage: 10, isHedged: false },
            },
          } as any);
        }, 0);
      }
    });

    await exchange.fetchPositionMetadata({
      accountId: "main",
      symbol: "BTCUSDT",
    });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fetchPositionMetadata",
        accountId: "main",
        symbol: "BTCUSDT",
        requestId: "test",
      }),
    );

    worker.postMessage = originalPostMessage;
    terminate();
  });

  test("should handle setLeverage", async () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const originalPostMessage = worker.postMessage;
    worker.postMessage = mock((message: any) => {
      if (message.requestId) {
        // Simulate worker response
        setTimeout(() => {
          exchange.onWorkerMessage({
            data: {
              type: "response",
              requestId: message.requestId,
              data: true,
            },
          } as any);
        }, 0);
      }
    });

    await exchange.setLeverage({
      accountId: "main",
      symbol: "BTCUSDT",
      leverage: 10,
    });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setLeverage",
        accountId: "main",
        symbol: "BTCUSDT",
        leverage: 10,
        requestId: "test",
      }),
    );

    worker.postMessage = originalPostMessage;
    terminate();
  });

  test("should handle listenOHLCV", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    worker.postMessage = mock(() => {});
    const callback = () => {};

    exchange.listenOHLCV({
      symbol: "BTCUSDT",
      timeframe: "1m",
      callback,
    });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "listenOHLCV",
      symbol: "BTCUSDT",
      timeframe: "1m",
    });

    expect(exchange.ohlcvListeners.get("BTCUSDT:1m")).toBe(callback);

    terminate();
  });

  test("should handle unlistenOHLCV", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    worker.postMessage = mock(() => {});
    const callback = () => {};

    exchange.ohlcvListeners.set("BTCUSDT:1m", callback);

    exchange.unlistenOHLCV({
      symbol: "BTCUSDT",
      timeframe: "1m",
    });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "unlistenOHLCV",
      symbol: "BTCUSDT",
      timeframe: "1m",
    });

    expect(exchange.ohlcvListeners.has("BTCUSDT:1m")).toBe(false);

    terminate();
  });

  test("should handle listenOrderBook", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    worker.postMessage = mock(() => {});
    const callback = () => {};

    exchange.listenOrderBook({
      symbol: "BTCUSDT",
      callback,
    });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "listenOB",
      symbol: "BTCUSDT",
    });

    expect(exchange.orderBookListeners.get("BTCUSDT")).toBe(callback);

    terminate();
  });

  test("should handle unlistenOrderBook", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    worker.postMessage = mock(() => {});
    const callback = () => {};

    exchange.orderBookListeners.set("BTCUSDT", callback);

    exchange.unlistenOrderBook("BTCUSDT");

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "unlistenOB",
      symbol: "BTCUSDT",
    });

    expect(exchange.orderBookListeners.has("BTCUSDT")).toBe(false);

    terminate();
  });

  test("should handle candle events", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const callback = mock(() => {});
    exchange.ohlcvListeners.set("BTCUSDT:1m", callback);

    const candle = { symbol: "BTCUSDT", timeframe: "1m", open: 50000 };
    exchange.handleCandle(candle as any);

    expect(callback).toHaveBeenCalledWith(candle);

    terminate();
  });

  test("should handle orderBook events", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const callback = mock(() => {});
    exchange.orderBookListeners.set("BTCUSDT", callback);

    const orderBook = { bids: [[50000, 1]], asks: [[50001, 1]] };
    exchange.handleOrderBook({
      symbol: "BTCUSDT",
      orderBook: orderBook as any,
    });

    expect(callback).toHaveBeenCalledWith(orderBook);

    terminate();
  });

  test("should handle response event", () => {
    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent: new FastTradingApi({ accounts: [] }),
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const resolver = mock(() => {});
    exchange.pendingRequests.set("test-id", resolver);

    exchange.handleResponse({ requestId: "test-id", data: "test-data" });

    expect(resolver).toHaveBeenCalledWith("test-data");
    expect(exchange.pendingRequests.has("test-id")).toBe(false);

    terminate();
  });

  test("should handle worker messages", () => {
    const parent = new FastTradingApi({ accounts: [] });
    parent.emit = mock(() => {});
    parent.store = { applyChanges: mock(() => {}) } as any;

    const exchange = new BaseExchange({
      name: ExchangeName.BYBIT,
      parent,
      createWorker,
      config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
    });

    const handleCandle = mock(() => {});
    const handleOrderBook = mock(() => {});
    const handleResponse = mock(() => {});

    exchange.handleCandle = handleCandle;
    exchange.handleOrderBook = handleOrderBook;
    exchange.handleResponse = handleResponse;

    // Test log message
    exchange.onWorkerMessage({
      data: { type: "log", message: "test log" },
    } as any);
    expect(parent.emit).toHaveBeenCalledWith("log", "test log");

    // Test error message
    const error = new Error("test error");
    exchange.onWorkerMessage({ data: { type: "error", error } } as any);
    expect(parent.emit).toHaveBeenCalledWith("error", error);

    // Test candle message
    const candle = { symbol: "BTCUSDT", timeframe: "1m" };
    exchange.onWorkerMessage({ data: { type: "candle", candle } } as any);
    expect(handleCandle).toHaveBeenCalledWith(candle);

    // Test orderBook message
    const orderBookData = {
      symbol: "BTCUSDT",
      orderBook: { bids: [], asks: [] },
    };
    exchange.onWorkerMessage({
      data: { type: "orderBook", ...orderBookData },
    } as any);
    expect(handleOrderBook).toHaveBeenCalledWith({
      type: "orderBook",
      ...orderBookData,
    });

    // Test response message
    const responseData = { requestId: "test-id", data: "test-data" };
    exchange.onWorkerMessage({
      data: { type: "response", ...responseData },
    } as any);
    expect(handleResponse).toHaveBeenCalledWith({
      type: "response",
      ...responseData,
    });

    // Test update message
    const changes = [{ path: ["test"], value: "test" }];
    exchange.onWorkerMessage({ data: { type: "update", changes } } as any);
    expect(parent.store.applyChanges).toHaveBeenCalledWith(changes);

    terminate();
  });
});
