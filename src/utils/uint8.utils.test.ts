import { describe, expect, test } from "bun:test";

import {
  hexToUint8Array,
  stringToUint8Array,
  uint8ArrayToHex,
  compareUint8Arrays,
} from "./uint8.utils";

describe("hex.utils", () => {
  describe("hexToUint8Array", () => {
    test("should convert hex string to Uint8Array correctly", () => {
      const hex = "48656c6c6f";
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle empty hex string", () => {
      const hex = "";
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle uppercase hex", () => {
      const hex = "48656C6C6F";
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle mixed case hex", () => {
      const hex = "48656c6C6f";
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle hex with all possible byte values", () => {
      const hex = "00FF80A5";
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle long hex string", () => {
      const hex = "0123456789abcdef".repeat(10);
      const result = hexToUint8Array(hex);
      const expected = Buffer.from(hex, "hex");

      expect(result).toEqual(new Uint8Array(expected));
    });
  });

  describe("stringToUint8Array", () => {
    test("should convert ASCII string to Uint8Array correctly", () => {
      const str = "Hello";
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle empty string", () => {
      const str = "";
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle string with special characters", () => {
      const str = "Hello!@#$%^&*()";
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle string with numbers", () => {
      const str = "abc123XYZ";
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle single character", () => {
      const str = "A";
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });

    test("should handle long string", () => {
      const str = "Hello World! ".repeat(100);
      const result = stringToUint8Array(str);
      const expected = Buffer.from(str, "latin1");

      expect(result).toEqual(new Uint8Array(expected));
    });
  });

  describe("uint8ArrayToHex", () => {
    test("should convert Uint8Array to hex string correctly", () => {
      const uint8Array = new Uint8Array([72, 101, 108, 108, 111]);
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
    });

    test("should handle empty Uint8Array", () => {
      const uint8Array = new Uint8Array([]);
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
    });

    test("should handle single byte", () => {
      const uint8Array = new Uint8Array([255]);
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
    });

    test("should handle all possible byte values", () => {
      const uint8Array = new Uint8Array([0, 127, 128, 255]);
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
    });

    test("should handle large array", () => {
      const uint8Array = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        uint8Array[i] = i % 256;
      }
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
    });

    test("should pad single digit hex values with zero", () => {
      const uint8Array = new Uint8Array([1, 2, 15, 16]);
      const result = uint8ArrayToHex(uint8Array);
      const expected = Buffer.from(uint8Array).toString("hex");

      expect(result).toBe(expected);
      expect(result).toBe("01020f10");
    });
  });

  describe("round-trip conversions", () => {
    test("hex -> Uint8Array -> hex should be identical", () => {
      const original = "48656c6c6f20776f726c64";
      const uint8Array = hexToUint8Array(original);
      const result = uint8ArrayToHex(uint8Array);

      expect(result).toBe(original);
    });

    test("string -> Uint8Array -> hex -> Uint8Array should preserve bytes", () => {
      const original = "Hello World!";
      const uint8Array1 = stringToUint8Array(original);
      const hex = uint8ArrayToHex(uint8Array1);
      const uint8Array2 = hexToUint8Array(hex);

      expect(uint8Array2).toEqual(uint8Array1);
    });

    test("should work with Buffer round-trip comparison", () => {
      const original = "Test string with special chars: !@#$%^&*()";

      // Our implementation
      const ourUint8Array = stringToUint8Array(original);
      const ourHex = uint8ArrayToHex(ourUint8Array);
      const ourFinalArray = hexToUint8Array(ourHex);

      // Buffer implementation
      const bufferUint8Array = Buffer.from(original, "latin1");
      const bufferHex = bufferUint8Array.toString("hex");
      const bufferFinalArray = Buffer.from(bufferHex, "hex");

      expect(ourUint8Array).toEqual(new Uint8Array(bufferUint8Array));
      expect(ourHex).toBe(bufferHex);
      expect(ourFinalArray).toEqual(new Uint8Array(bufferFinalArray));
    });
  });

  describe("compareUint8Arrays", () => {
    test("should return true for identical arrays", () => {
      const array1 = new Uint8Array([1, 2, 3, 4, 5]);
      const array2 = new Uint8Array([1, 2, 3, 4, 5]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should return true for empty arrays", () => {
      const array1 = new Uint8Array([]);
      const array2 = new Uint8Array([]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should return false for arrays with different lengths", () => {
      const array1 = new Uint8Array([1, 2, 3]);
      const array2 = new Uint8Array([1, 2, 3, 4]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(false);
      expect(result).toBe(expected);
    });

    test("should return false for arrays with same length but different content", () => {
      const array1 = new Uint8Array([1, 2, 3, 4]);
      const array2 = new Uint8Array([1, 2, 4, 4]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(false);
      expect(result).toBe(expected);
    });

    test("should return true for single element arrays with same value", () => {
      const array1 = new Uint8Array([42]);
      const array2 = new Uint8Array([42]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should return false for single element arrays with different values", () => {
      const array1 = new Uint8Array([42]);
      const array2 = new Uint8Array([43]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(false);
      expect(result).toBe(expected);
    });

    test("should handle arrays with all possible byte values", () => {
      const array1 = new Uint8Array([0, 127, 128, 255]);
      const array2 = new Uint8Array([0, 127, 128, 255]);
      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should handle large arrays", () => {
      const size = 1000;
      const array1 = new Uint8Array(size);
      const array2 = new Uint8Array(size);

      // Fill with same pattern
      for (let i = 0; i < size; i++) {
        array1[i] = i % 256;
        array2[i] = i % 256;
      }

      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should handle large arrays with difference at the end", () => {
      const size = 1000;
      const array1 = new Uint8Array(size);
      const array2 = new Uint8Array(size);

      // Fill with same pattern
      for (let i = 0; i < size; i++) {
        array1[i] = i % 256;
        array2[i] = i % 256;
      }

      // Make them different at the last element
      array2[size - 1] = (array2[size - 1] + 1) % 256;

      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(false);
      expect(result).toBe(expected);
    });

    test("should handle arrays from hex conversion", () => {
      const hex1 = "48656c6c6f20776f726c64";
      const hex2 = "48656c6c6f20776f726c64";
      const array1 = hexToUint8Array(hex1);
      const array2 = hexToUint8Array(hex2);

      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });

    test("should handle arrays from string conversion", () => {
      const str1 = "Hello World!";
      const str2 = "Hello World!";
      const array1 = stringToUint8Array(str1);
      const array2 = stringToUint8Array(str2);

      const result = compareUint8Arrays(array1, array2);
      const expected = Buffer.from(array1).equals(Buffer.from(array2));

      expect(result).toBe(true);
      expect(result).toBe(expected);
    });
  });
});
