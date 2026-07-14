import { describe, expect, it, vi } from "vitest";

import {
  classifyTokenContent,
  createTokenCounter,
  estimateTokens,
} from "../src/token.js";

describe("token counter", () => {
  it("uses an available model tokenizer instead of the calibrated fallback", () => {
    const tokenize = vi.fn(() => 7);
    const counter = createTokenCounter({ model: "gpt-4o", tokenize });

    expect(counter.count("任意 content")).toBe(7);
    expect(counter.id).toBe("local:gpt-4o");
    expect(tokenize).toHaveBeenCalledWith("任意 content");
  });

  it("classifies prose, CJK, code, and high-entropy content separately", () => {
    expect(classifyTokenContent("A short release readiness paragraph.")).toBe(
      "prose",
    );
    expect(classifyTokenContent("安全令牌轮换失败，必须立即处理。")).toBe("cjk");
    expect(
      classifyTokenContent(
        "export function rotate(value: string): boolean {\n  return value !== '';\n}",
      ),
    ).toBe("code");
    expect(
      classifyTokenContent("QWxhZGRpbjpvcGVuIHNlc2FtZQ==8f31A9bC2dE4f607"),
    ).toBe("high_entropy");
  });

  it("does not apply one chars-per-token ratio to every content class", () => {
    const prose = "routine release checklist words remain stable today";
    const cjk = "安全令牌轮换失败必须立即处理安全令牌轮换失败必须立即处理";
    const entropy = "QWxhZGRpbjpvcGVuIHNlc2FtZQ8f31A9bC2dE4f607";

    expect(estimateTokens(cjk) / cjk.length).toBeGreaterThan(
      estimateTokens(prose) / prose.length,
    );
    expect(estimateTokens(entropy) / entropy.length).toBeGreaterThan(
      estimateTokens(prose) / prose.length,
    );
  });

  it("keeps the historical small ASCII boundary behavior", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
