import { describe, expect, it } from "vitest";

import { esc, normalizeDigits } from "./wizard";

describe("normalizeDigits", () => {
  it("converts Persian digits to ASCII", () => {
    expect(normalizeDigits("۲۰۵۳")).toBe("2053");
  });

  it("converts Arabic-Indic digits to ASCII", () => {
    expect(normalizeDigits("١٢٣")).toBe("123");
  });

  it("strips grouping characters — including the Persian keyboard's own separators", () => {
    expect(normalizeDigits("1,000")).toBe("1000");
    expect(normalizeDigits("1،000")).toBe("1000");
    // U+066C Arabic thousands separator + U+066B Arabic decimal separator.
    expect(normalizeDigits("١٢٬٣٤٥٫٥")).toBe("12345.5");
  });

  it("strips the zero-width non-joiner between Persian words in a number field", () => {
    expect(normalizeDigits("1\u200c000")).toBe("1000");
  });

  it("leaves plain ASCII alone", () => {
    expect(normalizeDigits("42.5")).toBe("42.5");
  });
});

describe("esc", () => {
  it("escapes the three HTML-sensitive characters", () => {
    expect(esc(`<b>&"x"`)).toBe("&lt;b&gt;&amp;\"x\"");
  });

  it("leaves safe text untouched", () => {
    expect(esc("hello 👋")).toBe("hello 👋");
  });

  it("is the reason a user-supplied `<` cannot 400 an HTML message", () => {
    // The ticket subject is user text sent with parse_mode: "HTML".
    const subject = "<script>alert(1)</script>";
    expect(esc(subject)).not.toContain("<");
  });
});
