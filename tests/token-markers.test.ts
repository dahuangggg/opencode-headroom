import { describe, expect, it } from "vitest";

import { estimateTokens } from "../src/token.js";
import {
  CCR_HASH_RE,
  containsCCRMarker,
  formatJsonSentinel,
  formatRetrieveMarker,
  isValidCCRHash,
} from "../src/markers.js";

const hash = "0123456789abcdef01234567";

describe("estimateTokens", () => {
  it("estimates one token per four characters rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("CCR markers", () => {
  it("validates 24 character hex hashes", () => {
    expect(isValidCCRHash(hash)).toBe(true);
    expect(isValidCCRHash("012345")).toBe(false);
    expect(isValidCCRHash("zzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
  });

  it("matches hashes embedded in marker text", () => {
    expect("hash=0123456789abcdef01234567").toMatch(CCR_HASH_RE);
  });

  it("formats dropped-content and retrieve markers", () => {
    expect(formatJsonSentinel(hash, 12)).toEqual({
      _ccr_dropped: "<<ccr:0123456789abcdef01234567 12_rows_offloaded>>",
    });
    expect(formatRetrieveMarker(hash)).toBe(
      "[Retrieve more: hash=0123456789abcdef01234567]",
    );
  });

  it("detects Headroom-style CCR markers", () => {
    expect(
      containsCCRMarker(JSON.stringify(formatJsonSentinel(hash, 12))),
    ).toBe(true);
    expect(containsCCRMarker("<<ccr:0123456789ab,base64,4.5KB>>")).toBe(
      true,
    );
    expect(
      containsCCRMarker(
        "[100 lines compressed to 10. Retrieve more: hash=0123456789abcdef01234567]",
      ),
    ).toBe(true);
    expect(
      containsCCRMarker(
        "[100 lines compressed. hash=0123456789abcdef01234567]",
      ),
    ).toBe(true);
    expect(
      containsCCRMarker(
        "[Retrieve original: hash=0123456789abcdef01234567]",
      ),
    ).toBe(true);
    expect(containsCCRMarker(`x ${formatRetrieveMarker(hash)}`)).toBe(true);
    expect(containsCCRMarker("plain")).toBe(false);
  });
});
