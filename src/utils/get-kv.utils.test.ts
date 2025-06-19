import { describe, test, expect } from "bun:test";

import { getKV } from "./get-kv.utils";

describe("getKV", () => {
  test("should return undefined when object is undefined", () => {
    expect(getKV(undefined, "testKey")).toBeUndefined();
  });

  test("should return value for direct key match", () => {
    const obj = { testKey: "testValue" };
    expect(getKV(obj, "testKey")).toBe("testValue");
  });

  test("should return value for snake_case key when camelCase key is provided", () => {
    const obj = { test_key: "testValue" };
    expect(getKV(obj, "testKey")).toBe("testValue");
  });

  test("should return value for camelCase key when snake_case key is provided", () => {
    const obj = { testKey: "testValue" };
    expect(getKV(obj, "test_key")).toBe("testValue");
  });

  test("should prioritize direct key match over case conversions", () => {
    const obj = {
      testKey: "directMatch",
      test_key: "snakeCase",
    };
    expect(getKV(obj, "testKey")).toBe("directMatch");
  });

  test("should prioritize snake_case match over camelCase conversion", () => {
    const obj = {
      test_key: "snakeCase",
      testKey: "camelCase",
    };
    expect(getKV(obj, "test_key")).toBe("snakeCase");
  });

  test("should return undefined when no matching key is found", () => {
    const obj = { otherKey: "value" };
    expect(getKV(obj, "testKey")).toBeUndefined();
  });

  test("should handle complex camelCase to snake_case conversion", () => {
    const obj = { my_complex_key_name: "value" };
    expect(getKV(obj, "myComplexKeyName")).toBe("value");
  });

  test("should handle complex snake_case to camelCase conversion", () => {
    const obj = { myComplexKeyName: "value" };
    expect(getKV(obj, "my_complex_key_name")).toBe("value");
  });

  test("should handle single character keys", () => {
    const obj = { a: "value" };
    expect(getKV(obj, "a")).toBe("value");
  });

  test("should handle empty string key", () => {
    const obj = { "": "emptyValue" };
    expect(getKV(obj, "")).toBe("emptyValue");
  });

  test("should handle numeric values", () => {
    const obj = { testKey: 42 };
    expect(getKV(obj, "testKey")).toBe(42);
  });

  test("should handle boolean values", () => {
    const obj = { testKey: true };
    expect(getKV(obj, "testKey")).toBe(true);
  });

  test("should handle null values", () => {
    const obj = { testKey: null };
    expect(getKV(obj, "testKey")).toBeNull();
  });

  test("should handle nested object values", () => {
    const nestedObj = { nested: "value" };
    const obj = { testKey: nestedObj };
    expect(getKV(obj, "testKey")).toBe(nestedObj);
  });

  test("should handle array values", () => {
    const arrayValue = [1, 2, 3];
    const obj = { testKey: arrayValue };
    expect(getKV(obj, "testKey")).toBe(arrayValue);
  });

  test("should handle keys with leading/trailing underscores in snake_case conversion", () => {
    const obj = { _test_key_: "value" };
    expect(getKV(obj, "_testKey_")).toBe("value");
  });

  test("should handle keys with numbers", () => {
    const obj = { test_key_123: "value" };
    expect(getKV(obj, "testKey123")).toBe("value");
  });

  test("should handle already snake_case key when requesting snake_case", () => {
    const obj = { test_key: "value" };
    expect(getKV(obj, "test_key")).toBe("value");
  });

  test("should handle already camelCase key when requesting camelCase", () => {
    const obj = { testKey: "value" };
    expect(getKV(obj, "testKey")).toBe("value");
  });
});
