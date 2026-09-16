/**
 * Text extraction for documents uploaded to the dashboard agent.
 * PDF → pdf-parse, docx → mammoth, plain-text formats pass through.
 * Scanned/image-only PDFs are rejected (no OCR in v1).
 */
import mammoth from "mammoth";

const MAX_CHARS = 200_000;
const MIN_PDF_TEXT_CHARS = 100;

const PLAIN_TEXT_EXTENSIONS = [".txt", ".md", ".json", ".csv"];

export interface ParsedDocument {
  text: string;
  truncated: boolean;
}

export class DocumentParsingError extends Error {}

export async function extractText(
  buffer: Buffer,
  mimetype: string,
  filename: string,
): Promise<ParsedDocument> {
  const lower = filename.toLowerCase();

  let text: string;

  if (mimetype === "application/pdf" || lower.endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const parsed = await parser.getText();
      text = parsed.text || "";
    } finally {
      await parser.destroy();
    }
    if (text.trim().length < MIN_PDF_TEXT_CHARS) {
      throw new DocumentParsingError(
        "This PDF appears to be scanned images with no readable text. Please upload a text-based document instead.",
      );
    }
  } else if (
    mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || "";
  } else if (
    mimetype.startsWith("text/") ||
    mimetype === "application/json" ||
    PLAIN_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
  ) {
    text = buffer.toString("utf-8");
  } else {
    throw new DocumentParsingError(
      "Unsupported file type. Upload a PDF, Word document (.docx), or plain text file (.txt, .md, .json, .csv).",
    );
  }

  if (!text.trim()) {
    throw new DocumentParsingError(
      "No readable text was found in this document.",
    );
  }

  const truncated = text.length > MAX_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_CHARS) : text,
    truncated,
  };
}
