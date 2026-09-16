/**
 * Minimal markdown → HTML renderer for transactional email bodies.
 *
 * Plunk's current /send API no longer converts `type: "markdown"` bodies
 * (it treats them as plain text), so we convert before sending. Supports the
 * subset used by our notification/alert templates: headings, bold, italic,
 * inline code, links, unordered lists, horizontal rules and paragraphs.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline markdown (bold, italic, code, links) on already-escaped text. */
function renderInline(escaped: string): string {
  return escaped
    .replace(
      /`([^`]+)`/g,
      '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f2f2;padding:0.1em 0.35em;border-radius:4px;">$1</code>',
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" style="color:#2563eb;">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
}

export function renderMarkdownToHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/);

  const html = blocks.map((rawBlock) => {
    const block = rawBlock.trim();

    if (/^---+$/.test(block)) {
      return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5em 0;" />';
    }

    const heading = block.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes: Record<number, string> = {
        1: "1.6em",
        2: "1.35em",
        3: "1.15em",
      };
      return `<h${level} style="margin:0 0 0.6em;font-size:${
        sizes[level] ?? "1em"
      };">${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`;
    }

    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
        .map((item) => `<li style="margin:0.25em 0;">${renderInline(escapeHtml(item))}</li>`)
        .join("");
      return `<ul style="padding-left:1.4em;margin:0.8em 0;">${items}</ul>`;
    }

    const content = lines.map((line) => escapeHtml(line.trim())).join("<br />");
    return `<p style="margin:0.8em 0;">${renderInline(content)}</p>`;
  });

  return html.join("\n");
}

/** Wrap rendered markdown in a minimal, email-client-safe HTML document. */
export function wrapEmailHtml(bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.6;">',
    bodyHtml,
    "</body></html>",
  ].join("");
}
