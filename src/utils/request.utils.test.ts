import {
  test,
  describe,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
} from "bun:test";

import { request } from "./request.utils";
import * as retryUtils from "./retry.utils";

describe("request utility", () => {
  const originalFetch = global.fetch;
  const mockJsonResponse = { data: "test response" };

  beforeEach(() => {
    // Mock the retry function to just call the callback once
    spyOn(retryUtils, "retry").mockImplementation((fn, _retries) => fn());

    // Mock fetch to return a successful response
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    global.fetch = mock(
      () =>
        Promise.resolve({
          json: () => Promise.resolve(mockJsonResponse),
        }) as unknown as Response,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("makes a basic GET request", async () => {
    const result = await request({
      url: "https://api.example.com/data",
    });

    expect(result).toEqual(mockJsonResponse);
    expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
      method: "GET",
      body: undefined,
      headers: undefined,
    });
  });

  test("makes a GET request with query parameters", async () => {
    await request({
      url: "https://api.example.com/data",
      params: { id: 123, filter: "active" },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.example.com/data?id=123&filter=active",
      {
        method: "GET",
        body: undefined,
        headers: undefined,
      },
    );
  });

  test("makes a POST request with body", async () => {
    await request({
      url: "https://api.example.com/data",
      method: "POST",
      body: { name: "test", values: [1, 2, 3] },
    });

    expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
      method: "POST",
      body: JSON.stringify({ name: "test", values: [1, 2, 3] }),
      headers: undefined,
    });
  });

  test("includes custom headers in the request", async () => {
    await request({
      url: "https://api.example.com/data",
      headers: {
        Authorization: "Bearer token123",
        "Content-Type": "application/json",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
      method: "GET",
      body: undefined,
      headers: {
        Authorization: "Bearer token123",
        "Content-Type": "application/json",
      },
    });
  });

  test("uses the retry utility with specified retry count", async () => {
    await request({
      url: "https://api.example.com/data",
      retries: 3,
    });

    expect(retryUtils.retry).toHaveBeenCalledWith(expect.any(Function), 3);
  });

  test("uses default retry count of 0 when not specified", async () => {
    await request({
      url: "https://api.example.com/data",
    });

    expect(retryUtils.retry).toHaveBeenCalledWith(expect.any(Function), 0);
  });
});
