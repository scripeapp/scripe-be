/**
 * Utility function to chunk array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) return [array];
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Event date helpers. A null (or empty) start date is the single source of
 * truth for an event whose date is "to be disclosed" (TBD). Guard every place
 * that renders or parses an event date with `isEventDateTbd` so TBD events
 * never reach a Date constructor (new Date(null) silently yields 1970-01-01).
 */

export const EVENT_DATE_TBD_LABEL = "TBD — Date to be Disclosed";

export const isEventDateTbd = (
  startDate: string | null | undefined,
): startDate is null | undefined => !startDate;

export const formatEventDate = (
  startDate: string | null | undefined,
  startTime?: string | null,
): string =>
  isEventDateTbd(startDate)
    ? EVENT_DATE_TBD_LABEL
    : [startDate, startTime].filter(Boolean).join(" · ");

/**
 * Truncates text to a specified character limit while maintaining complete sentences
 */
export function truncatePreview(text: string, charLimit = 160): string {
  if (text.length <= charLimit) return text;
  const truncated = text.slice(0, charLimit);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastExclamation = truncated.lastIndexOf("!");
  const lastQuestion = truncated.lastIndexOf("?");
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  if (lastSentenceEnd > 0) return text.slice(0, lastSentenceEnd + 1).trim();
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 0) return text.slice(0, lastSpace).trim();
  return truncated.trim();
}

/**
 * Truncate text and add ellipsis if truncated
 */
export function truncatePreviewWithEllipsis(
  text: string,
  charLimit = 160,
): string {
  const truncated = truncatePreview(text, charLimit);
  return truncated.length < text.length ? `${truncated}...` : truncated;
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).length;
}

/**
 * Truncate by word count instead of characters
 */
export function truncateByWords(text: string, wordLimit = 25): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= wordLimit) return text;
  return words.slice(0, wordLimit).join(" ");
}

export const EMAIL_TEMPLATES: Record<string, number> = {
  NEW_COMMENT: 37493788,
  NEW_LIKE: 37493785,
  NEW_POST: 37324987,
  NEW_POST_TO_SUBSCRIBERS: 37495520,
  NEW_PUBLICATION: 37325129,
  NEW_SIGNUP: 37325103,
  NEW_SUBSCRIBER: 37495519,
  NEW_TIP: 37495550,
};

/**
 * Convert DraftJS raw content to simple HTML
 * Handles inline styles (BOLD, ITALIC), entity ranges (LINK), and newlines.
 */
export function convertDraftToHtml(rawContent: string): string {
  try {
    if (!rawContent) return "";

    // If it's likely HTML (starts with <), return it
    if (
      typeof rawContent === "string" &&
      rawContent.trim().startsWith("<") &&
      !rawContent.trim().startsWith("{")
    ) {
      return rawContent;
    }

    const contentState =
      typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;

    if (!contentState.blocks)
      return typeof rawContent === "string" ? rawContent : "";

    // Pre-process: split blocks containing \n into multiple blocks.
    const processedBlocks: any[] = [];
    for (const block of contentState.blocks) {
      if (block.type === "unstyled" && block.text.includes("\n")) {
        const lines = block.text.split("\n");
        let offset = 0;
        for (const line of lines) {
          const lineEnd = offset + line.length;
          // Filter inline styles for this line segment
          const lineStyles = (block.inlineStyleRanges || [])
            .filter(
              (s: any) => s.offset < lineEnd && s.offset + s.length > offset,
            )
            .map((s: any) => ({
              ...s,
              offset: Math.max(0, s.offset - offset),
              length:
                Math.min(lineEnd, s.offset + s.length) -
                Math.max(offset, s.offset),
            }));
          // Filter entity ranges for this line segment
          const lineEntities = (block.entityRanges || [])
            .filter(
              (e: any) => e.offset < lineEnd && e.offset + e.length > offset,
            )
            .map((e: any) => ({
              ...e,
              offset: Math.max(0, e.offset - offset),
              length:
                Math.min(lineEnd, e.offset + e.length) -
                Math.max(offset, e.offset),
            }));
          processedBlocks.push({
            ...block,
            key: `${block.key}_${offset}`,
            text: line,
            inlineStyleRanges: lineStyles,
            entityRanges: lineEntities,
          });
          offset = lineEnd + 1; // +1 for the \n character
        }
      } else {
        processedBlocks.push(block);
      }
    }

    const entityMap = contentState.entityMap || {};

    /**
     * Apply inline styles and entity ranges to block text.
     * Builds styled HTML from plain text using offsets/lengths.
     */
    function renderInlineContent(block: any): string {
      let text: string = block.text || "";
      if (!text) return "";

      // Basic escaping
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Collect all style/entity markers at each character boundary
      const chars = [...escaped];
      // We need to map original offsets to escaped offsets carefully.
      // Since we only escape single chars (&, <, >), offsets shift.
      // Rebuild using original text offsets and apply to escaped segments.

      // Build per-character style/entity info from ORIGINAL text
      const origLen = text.length;
      const charStyles: Set<string>[] = Array.from(
        { length: origLen },
        () => new Set(),
      );
      const charEntity: (string | null)[] = Array.from(
        { length: origLen },
        () => null,
      );

      // Apply inline style ranges
      if (block.inlineStyleRanges) {
        for (const range of block.inlineStyleRanges) {
          const end = Math.min(range.offset + range.length, origLen);
          for (let i = range.offset; i < end; i++) {
            charStyles[i].add(range.style);
          }
        }
      }

      // Apply entity ranges
      if (block.entityRanges) {
        for (const range of block.entityRanges) {
          const end = Math.min(range.offset + range.length, origLen);
          for (let i = range.offset; i < end; i++) {
            charEntity[i] = String(range.key);
          }
        }
      }

      // Build HTML by grouping chars with same styles/entities
      let result = "";
      let i = 0;
      while (i < origLen) {
        const currentStyles = charStyles[i];
        const currentEntity = charEntity[i];

        // Find the run of chars with the same styles+entity
        let j = i;
        while (
          j < origLen &&
          setsEqual(charStyles[j], currentStyles) &&
          charEntity[j] === currentEntity
        ) {
          j++;
        }

        // Escape and get the segment text
        let segment = text
          .slice(i, j)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");

        // Wrap in inline style tags
        if (currentStyles.has("BOLD")) segment = `<strong>${segment}</strong>`;
        if (currentStyles.has("ITALIC")) segment = `<em>${segment}</em>`;
        if (currentStyles.has("UNDERLINE")) segment = `<u>${segment}</u>`;

        // Wrap in entity tag (LINK)
        if (currentEntity !== null && entityMap[currentEntity]) {
          const entity = entityMap[currentEntity];
          if (entity.type === "LINK" && entity.data?.url) {
            segment = `<a href="${entity.data.url}" target="_blank" rel="noopener noreferrer" style="color: #5046E5; text-decoration: underline;">${segment}</a>`;
          }
        }

        result += segment;
        i = j;
      }

      return result;
    }

    function setsEqual(a: Set<string>, b: Set<string>): boolean {
      if (a.size !== b.size) return false;
      for (const item of a) {
        if (!b.has(item)) return false;
      }
      return true;
    }

    let html = "";
    let listType: string | null = null;

    processedBlocks.forEach((block: any) => {
      // Handle lists
      if (block.type === "unordered-list-item") {
        if (listType !== "ul") {
          if (listType === "ol") html += "</ol>";
          html += "<ul>";
          listType = "ul";
        }
        html += `<li>${renderInlineContent(block)}</li>`;
      } else if (block.type === "ordered-list-item") {
        if (listType !== "ol") {
          if (listType === "ul") html += "</ul>";
          html += "<ol>";
          listType = "ol";
        }
        html += `<li>${renderInlineContent(block)}</li>`;
      } else {
        // Close any open list
        if (listType === "ul") {
          html += "</ul>";
          listType = null;
        }
        if (listType === "ol") {
          html += "</ol>";
          listType = null;
        }

        // Handle atomic blocks (IMAGE, BUTTON, etc.)
        if (block.type === "atomic") {
          const entityKey = block.entityRanges?.[0]?.key;
          if (entityKey !== undefined) {
            const entity = entityMap[String(entityKey)];
            if (entity?.type === "BUTTON") {
              // Skip button blocks in email — they rely on JS
              return;
            }
            if (entity?.type === "IMAGE" && entity.data?.src) {
              const src = String(entity.data.src);
              // Never embed blob/data URLs in email
              if (!src.startsWith("blob:") && !src.startsWith("data:")) {
                const alt = entity.data.alt || "";
                const caption = entity.data.caption || "";
                html += `<div style="text-align:center;margin:20px 0;">`;
                html += `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:6px;display:block;margin:0 auto;" />`;
                if (caption) {
                  html += `<p style="font-size:13px;color:#64748b;margin:6px 0 0;font-style:italic;">${caption}</p>`;
                }
                html += `</div>`;
              }
              return;
            }
          }
          // Unknown atomic entity — skip it
          return;
        }

        switch (block.type) {
          case "header-one":
            html += `<h1>${renderInlineContent(block)}</h1>`;
            break;
          case "header-two":
            html += `<h2>${renderInlineContent(block)}</h2>`;
            break;
          case "header-three":
            html += `<h3>${renderInlineContent(block)}</h3>`;
            break;
          case "blockquote":
            html += `<blockquote style="border-left: 4px solid #5046E5; padding: 12px 16px; margin: 16px 0; color: #555; font-style: italic;">${renderInlineContent(block)}</blockquote>`;
            break;
          case "code-block":
            html += `<pre style="background:#f4f4f4;padding:10px;border-radius:4px;"><code>${renderInlineContent(block)}</code></pre>`;
            break;
          default: {
            const content = renderInlineContent(block);
            if (content && content.trim().length > 0) {
              html += `<p style="margin-bottom: 1em; line-height: 1.6;">${content}</p>`;
            }
            // Skip empty/whitespace-only blocks (don't even add <br />)
          }
        }
      }
    });

    // Close any remaining list
    if (listType === "ul") html += "</ul>";
    if (listType === "ol") html += "</ol>";

    return html;
  } catch (e) {
    // If parsing fails, return original content
    return typeof rawContent === "string" ? rawContent : "";
  }
}

export default {
  truncatePreview,
  truncatePreviewWithEllipsis,
  countWords,
  truncateByWords,
  chunk,
  convertDraftToHtml,
  EMAIL_TEMPLATES,
  EVENT_DATE_TBD_LABEL,
  isEventDateTbd,
  formatEventDate,
};
