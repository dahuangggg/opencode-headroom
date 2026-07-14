import { describe, expect, it } from "vitest";

import { compressHtml } from "../src/compressors/html.js";
import { compressByContentType, detectContentType } from "../src/engine/router.js";

const hash = "0123456789abcdef01234567";

function htmlFixture(): string {
  return [
    "<!doctype html><html><head>",
    "<title>Security Runbook HR-204</title>",
    "<style>.noise{display:none}</style>",
    "<script>window.secretTracking = true</script>",
    "</head><body>",
    "<nav>Home Products Pricing Changelog</nav>",
    "<main><h1>Credential rotation</h1>",
    "<p>Security incident HR-204 requires credential rotation before publish.</p>",
    '<a href="/runbooks/hr-204">Open the HR-204 runbook</a>',
    "<table><tr><th>tenant</th><th>status</th></tr>",
    "<tr><td>tenant-critical</td><td>ERROR</td></tr></table>",
    ...Array.from({ length: 80 }, (_, index) =>
      `<p>Routine operational note ${index} is stable.</p>`,
    ),
    "</main><footer>Legal Privacy Status</footer></body></html>",
  ].join("\n");
}

describe("HTML compressor", () => {
  it("keeps title, main content, links, tables, and error content", () => {
    const result = compressHtml({
      content: htmlFixture(),
      hash,
      query: "HR-204 credential rotation tenant-critical",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("Security Runbook HR-204");
    expect(result.output).toContain(
      "Security incident HR-204 requires credential rotation before publish.",
    );
    expect(result.output).toContain(
      "[Open the HR-204 runbook](/runbooks/hr-204)",
    );
    expect(result.output).toContain("tenant-critical | ERROR");
    expect(result.output).not.toContain("secretTracking");
    expect(result.output).not.toContain("Home Products Pricing");
    expect(result.output).not.toContain("Legal Privacy Status");
    expect(result.output).toContain("[Retrieve more: hash=");
  });

  it("detects and routes full HTML documents", () => {
    const original = htmlFixture();
    const result = compressByContentType({
      content: original,
      hash,
      query: "HR-204 credential rotation",
    });

    expect(detectContentType(original).kind).toBe("html");
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("html");
  });

  it("leaves small fragments unchanged", () => {
    const fragment = "<p>Hello world</p>";
    expect(compressHtml({ content: fragment, hash, query: "" })).toMatchObject({
      changed: false,
      output: fragment,
    });
  });
});
