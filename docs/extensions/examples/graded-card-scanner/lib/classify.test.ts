// Unit tests for grader classification from decoded barcode/QR payloads.
// Pure functions — no I/O.

import { describe, expect, test } from "bun:test";
import { classifyDecode } from "./classify";

describe("classifyDecode — PSA", () => {
  test("bare 5-10 digit ITF payload (front label) → PSA", () => {
    expect(classifyDecode("49392223")).toEqual({ grader: "PSA", cert: "49392223" });
    expect(classifyDecode("12345")).toEqual({ grader: "PSA", cert: "12345" });
  });

  test("psacard.com cert URL (back QR) → PSA with the extracted digits", () => {
    expect(classifyDecode("https://www.psacard.com/cert/49392223?utm=qr")).toEqual({
      grader: "PSA",
      cert: "49392223",
    });
  });

  test("surrounding whitespace is tolerated", () => {
    expect(classifyDecode("  49392223  ")).toEqual({ grader: "PSA", cert: "49392223" });
  });
});

describe("classifyDecode — CGC", () => {
  test("cgccards.com certlookup URL → CGC", () => {
    expect(classifyDecode("https://www.cgccards.com/certlookup/4189145001/")).toEqual({
      grader: "CGC",
      cert: "4189145001",
    });
  });

  test("cgccomics.com URL → CGC (comics slabs share the scheme)", () => {
    expect(classifyDecode("https://www.cgccomics.com/certlookup/1234567890/")).toEqual({
      grader: "CGC",
      cert: "1234567890",
    });
  });
});

describe("classifyDecode — BGS / SGC", () => {
  test("beckett.com lookup URL with a serial → BGS", () => {
    expect(
      classifyDecode("https://www.beckett.com/grading/card-lookup?item=0012345678"),
    ).toEqual({ grader: "BGS", cert: "0012345678" });
  });

  test("gosgc.com URL → SGC; legacy sgccard.com too", () => {
    expect(classifyDecode("https://gosgc.com/cert-code-lookup/1234567")).toEqual({
      grader: "SGC",
      cert: "1234567",
    });
    expect(classifyDecode("https://www.sgccard.com/lookup?serial=7654321")).toEqual({
      grader: "SGC",
      cert: "7654321",
    });
  });
});

describe("classifyDecode — unknown (honest nulls)", () => {
  test("null / non-string / blank → unknown", () => {
    expect(classifyDecode(null)).toEqual({ grader: "unknown", cert: null });
    expect(classifyDecode(undefined)).toEqual({ grader: "unknown", cert: null });
    expect(classifyDecode(42)).toEqual({ grader: "unknown", cert: null });
    expect(classifyDecode("   ")).toEqual({ grader: "unknown", cert: null });
  });

  test("digits outside 5-10 length are NOT a PSA cert", () => {
    expect(classifyDecode("1234")).toEqual({ grader: "unknown", cert: null });
    expect(classifyDecode("12345678901")).toEqual({ grader: "unknown", cert: null });
  });

  test("an unrelated URL / arbitrary text → unknown", () => {
    expect(classifyDecode("https://example.com/whatever/123456")).toEqual({
      grader: "unknown",
      cert: null,
    });
    expect(classifyDecode("hello world")).toEqual({ grader: "unknown", cert: null });
  });

  test("company URL WITHOUT a digit run → unknown (no cert to extract)", () => {
    expect(classifyDecode("https://www.cgccards.com/about-us/")).toEqual({
      grader: "unknown",
      cert: null,
    });
  });
});
