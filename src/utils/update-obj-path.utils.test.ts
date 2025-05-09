import { describe, expect, test } from "bun:test";

import {
  applyChanges,
  removeArrayElementAtPath,
  updateObjectPath,
  removeObjectKeyAtPath,
} from "./update-obj-path.utils";

type Store = Record<
  "bybit",
  {
    public: {
      tickers: Record<string, { last: number }>;
    };
    private: {
      accounts?: {
        balance: { total: number };
        positions: { upnl: number }[];
        subaccounts: { positions: { upnl: number }[] }[];
      }[];
    } & Record<
      string,
      {
        balance: { total: number };
        positions: { upnl: number }[];
      }
    >;
  }
>;

const store: Store = {
  bybit: {
    public: { tickers: {} },
    private: {},
  },
};

describe("updateObjectPath", () => {
  test("updateObjectPath", () => {
    updateObjectPath({
      obj: store,
      path: "bybit.public.tickers",
      value: {
        BTCUSDT: { last: 1000 },
      },
    });
    expect(store.bybit.public.tickers.BTCUSDT.last).toBe(1000);

    updateObjectPath({
      obj: store,
      path: "bybit.public.tickers.BTCUSDT.last",
      value: 2000,
    });
    expect(store.bybit.public.tickers.BTCUSDT.last).toBe(2000);

    updateObjectPath({
      obj: store,
      path: "bybit.private.main",
      value: {
        balance: { total: 1000 },
        positions: [{ upnl: 100 }],
      },
    });

    expect(store.bybit.private.main.balance.total).toBe(1000);
    expect(store.bybit.private.main.positions[0].upnl).toBe(100);

    updateObjectPath({
      obj: store,
      path: "bybit.private.main.balance.total",
      value: 2000,
    });
    expect(store.bybit.private.main.balance.total).toBe(2000);

    updateObjectPath({
      obj: store,
      path: "bybit.private.main.positions.0.upnl",
      value: 200,
    });
    expect(store.bybit.private.main.positions[0].upnl).toBe(200);

    updateObjectPath({
      obj: store,
      path: "bybit.private.main.positions.1",
      value: { upnl: 300 },
    });
    expect(store.bybit.private.main.positions[1].upnl).toBe(300);
  });

  test("removeArrayElementAtPath", () => {
    expect(store.bybit.private.main.positions.length).toBe(2);
    expect(store.bybit.private.main.positions[0].upnl).toBe(200);

    removeArrayElementAtPath({
      obj: store,
      path: "bybit.private.main.positions",
      index: 0,
    });

    expect(store.bybit.private.main.positions.length).toBe(1);
    expect(store.bybit.private.main.positions[0].upnl).toBe(300);
  });

  test("removeArrayElementAtPath with out of bounds index", () => {
    // Setup nested structure with arrays in the path
    updateObjectPath({
      obj: store,
      path: "bybit.private.main",
      value: {
        balance: { total: 1000 },
        positions: [{ upnl: 100 }, { upnl: 200 }],
      },
    });

    expect(store.bybit.private.main.positions.length).toBe(2);

    removeArrayElementAtPath({
      obj: store,
      path: "bybit.private.main.positions",
      index: -1,
    });

    expect(store.bybit.private.main.positions.length).toBe(2);

    removeArrayElementAtPath({
      obj: store,
      path: "bybit.private.main.positions",
      index: 2,
    });

    expect(store.bybit.private.main.positions.length).toBe(2);

    removeArrayElementAtPath({
      obj: store,
      path: "bybit.private.main.positions",
      index: 0,
    });

    expect(store.bybit.private.main.positions.length).toBe(1);
    expect(store.bybit.private.main.positions[0].upnl).toBe(200);
  });

  test("removeArrayElementAtPath with numeric path segment", () => {
    // Setup nested structure with arrays in the path
    updateObjectPath({
      obj: store,
      path: "bybit.private.accounts",
      value: [
        {
          balance: { total: 1000 },
          positions: [{ upnl: 100 }],
          subaccounts: [{ positions: [{ upnl: 100 }, { upnl: 200 }] }],
        },
      ],
    });

    // Test removing element from an array that's accessed through numeric indices in the path
    removeArrayElementAtPath({
      obj: store,
      path: "bybit.private.accounts.0.subaccounts.0.positions" as any,
      index: 0,
    });

    expect(
      store.bybit.private.accounts![0].subaccounts[0].positions.length,
    ).toBe(1);
    expect(
      store.bybit.private.accounts![0].subaccounts[0].positions[0].upnl,
    ).toBe(200);
  });

  test("applyChanges", () => {
    updateObjectPath({
      obj: store,
      path: "bybit.private.main.positions",
      value: [{ upnl: 100 }, { upnl: 200 }, { upnl: 300 }, { upnl: 400 }],
    });

    applyChanges({
      obj: store,
      changes: [
        {
          type: "removeArrayElement",
          path: "bybit.private.main.positions",
          index: 0,
        },
        {
          type: "removeArrayElement",
          path: "bybit.private.main.positions",
          index: 0,
        },
      ],
    });

    expect(store.bybit.private.main.positions.length).toBe(2);
    expect(store.bybit.private.main.positions[0].upnl).toBe(300);
    expect(store.bybit.private.main.positions[1].upnl).toBe(400);
  });

  test("applyChanges with update", () => {
    applyChanges({
      obj: store,
      changes: [
        {
          type: "update",
          path: "bybit.private.main.balance.total",
          value: 5000,
        },
      ],
    });

    expect(store.bybit.private.main.balance.total).toBe(5000);
  });
});

describe("removeObjectKeyAtPath", () => {
  test("remove existing key", () => {
    // Set a key to remove
    updateObjectPath({
      obj: store,
      path: "bybit.public.tickers",
      value: { ETHUSDT: { last: 123 } },
    });
    expect(store.bybit.public.tickers.ETHUSDT).toBeDefined();
    removeObjectKeyAtPath({
      obj: store,
      path: "bybit.public.tickers",
      key: "ETHUSDT",
    });
    expect(store.bybit.public.tickers.ETHUSDT).toBeUndefined();
  });

  test("non-existing key does nothing", () => {
    const keysBefore = Object.keys(store.bybit.public.tickers);
    removeObjectKeyAtPath({
      obj: store,
      path: "bybit.public.tickers",
      key: "UNKNOWN",
    });
    expect(Object.keys(store.bybit.public.tickers)).toEqual(keysBefore);
  });
});

describe("applyChanges with removeObjectKey", () => {
  test("removeObjectKey change in applyChanges", () => {
    // Setup key to remove via applyChanges
    updateObjectPath({
      obj: store,
      path: "bybit.public.tickers",
      value: { XRPUSDT: { last: 321 } },
    });
    expect(store.bybit.public.tickers.XRPUSDT).toBeDefined();
    applyChanges({
      obj: store,
      changes: [
        {
          type: "removeObjectKey",
          path: "bybit.public.tickers",
          key: "XRPUSDT",
        },
      ],
    });
    expect(store.bybit.public.tickers.XRPUSDT).toBeUndefined();
  });
});
