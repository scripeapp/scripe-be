import { renderMarkdownToHtml, wrapEmailHtml } from "../utils/markdown-email";

describe("markdown-email renderer", () => {
  it("renders the orphaned-payment alert structure", () => {
    const html = renderMarkdownToHtml(
      [
        "## 1 Orphaned Payment Need Attention",
        "",
        "Found transactions marked **success** with no matching order.",
        "",
        "### Affected Transactions",
        "",
        "- **EVT-11af050e** | ₦206.10 | paid 21/08/2026",
        "",
        "### Next Steps",
        "",
        "Open the [Payment Recovery page](https://hilaq.com/admin/payments) to fulfill.",
        "",
        "---",
        "",
        "*Sent automatically.*",
      ].join("\n"),
    );

    expect(html).toContain('<h2 style="margin:0 0 0.6em;font-size:1.35em;">');
    expect(html).toContain("<strong>success</strong>");
    expect(html).toContain("<h3");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong>EVT-11af050e</strong>");
    expect(html).toContain('href="https://hilaq.com/admin/payments"');
    expect(html).toContain("<hr");
    expect(html).toContain("<em>Sent automatically.</em>");
    expect(html).not.toContain("**");
    expect(html).not.toContain("## ");
  });

  it("escapes HTML in source markdown", () => {
    const html = renderMarkdownToHtml("Hello <script>alert(1)</script> **bold**");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders inline code and paragraphs with line breaks", () => {
    const html = renderMarkdownToHtml("Use `EVT-123` ref\nsecond line");
    expect(html).toContain("<code");
    expect(html).toContain("EVT-123</code>");
    expect(html).toContain("<br />");
  });

  it("wraps rendered bodies in a full HTML document", () => {
    const wrapped = wrapEmailHtml("<p>Hi</p>");
    expect(wrapped.startsWith("<!doctype html>")).toBe(true);
    expect(wrapped.endsWith("</body></html>")).toBe(true);
  });
});
