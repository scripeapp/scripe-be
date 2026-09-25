import { escapeHtml } from "./email.js";

describe("escapeHtml", () => {
  it("neutralises markup in user-supplied values", () => {
    expect(escapeHtml(`Acme <a href="https://evil.example">Ltd</a> & 'Co'`)).toBe(
      "Acme &lt;a href=&quot;https://evil.example&quot;&gt;Ltd&lt;/a&gt; &amp; &#39;Co&#39;",
    );
  });
});
