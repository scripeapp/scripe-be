/**
 * Plunk Client — Lightweight SDK for the Plunk Email API (v0.7.x)
 *
 * Zero dependencies (uses native `fetch`). Fully typed for TypeScript.
 * Designed to be extractable into a standalone npm package.
 *
 * Plunk uses two key types for different endpoints:
 *   - Secret key (`sk_*`)  → transactional `/send`
 *   - Public key (`pk_*`)  → event `/track` (contact creation)
 * Pass the public key via `publicApiKey` so each endpoint authenticates correctly.
 *
 * @example
 * ```ts
 * const client = new PlunkClient('sk_...', { publicApiKey: 'pk_...' });
 * await client.send({ to: 'user@example.com', subject: 'Hi', body: '<p>Hello</p>' });
 * await client.track({ event: 'signup', email: 'user@example.com' });
 * ```
 */

// ============================================================================
// Types
// ============================================================================

import {
  renderMarkdownToHtml,
  wrapEmailHtml,
} from '../utils/markdown-email';

export interface PlunkClientOptions {
  /** Base URL for the Plunk API. Defaults to `https://next-api.useplunk.com/v1` */
  baseUrl?: string;
  /** Default sender email address (used when `from` is not passed to send()) */
  defaultFrom?: string;
  /**
   * Public API key (`pk_*`) used for the `/track` endpoint. Plunk requires the
   * public key for event/contact tracking, distinct from the secret key (`sk_*`)
   * used for `/send`. Falls back to the constructor's secret key if omitted.
   */
  publicApiKey?: string;
}

export interface SendEmailParams {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** Email body (HTML) */
  body: string;
  /** Sender display name */
  name?: string;
  /** Sender email address (must be a verified domain) */
  from?: string;
  /** Reply-to email address */
  replyTo?: string;
  /** Content type for the body */
  type?: 'html' | 'markdown';
  /** Metadata to include with the email for tracking */
  metadata?: Record<string, string | number | boolean>;
}

export interface SendEmailResponse {
  success?: boolean;
  /**
   * Plunk's /send returns one entry per recipient. Note: `email` here is the
   * email record UUID (the tracking webhook echoes it as event.emailId), while
   * the recipient address is under `contact.email`.
   */
  emails?: Array<{
    contact: { id: string; email: string };
    email: string;
  }>;
  timestamp?: string;
  /** Some API builds also return the id directly. */
  emailId?: string;
}

export interface TrackEventParams {
  /** Event name */
  event: string;
  /** Email address of the contact */
  email: string;
  /** Optional event data / properties */
  data?: Record<string, any>;
}

export interface TrackEventResponse {
  success: boolean;
  contact?: string;
}

// ============================================================================
// Error class
// ============================================================================

export class PlunkError extends Error {
  public readonly status: number;
  public readonly responseBody: any;

  constructor(message: string, status: number, responseBody?: any) {
    super(message);
    this.name = 'PlunkError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

// ============================================================================
// Client
// ============================================================================

export class PlunkClient {
  /** Secret key (`sk_*`) — used for `/send`. */
  private readonly apiKey: string;
  /** Public key (`pk_*`) — used for `/track`. Falls back to the secret key. */
  private readonly publicApiKey: string;
  private readonly baseUrl: string;
  private readonly defaultFrom?: string;

  constructor(apiKey: string, options: PlunkClientOptions = {}) {
    this.apiKey = apiKey;
    this.publicApiKey = options.publicApiKey || apiKey;
    this.baseUrl = (options.baseUrl || 'https://next-api.useplunk.com/v1').replace(/\/+$/, '');
    this.defaultFrom = options.defaultFrom;
  }

  /**
   * Send a transactional email.
   */
  async send(params: SendEmailParams): Promise<SendEmailResponse> {
    const from = params.from || this.defaultFrom;

    const payload: Record<string, any> = {
      to: params.to,
      subject: params.subject,
      body: params.body,
    };

    if (params.name) payload.name = params.name;
    if (from) payload.from = from;
    if (params.replyTo) payload.replyTo = params.replyTo;
    // Plunk's current /send API treats bodies as HTML/plain only — it no
    // longer converts markdown. Render it ourselves so `type: "markdown"`
    // callers (scheduler alerts, notifications) get properly formatted mail.
    if (params.type === 'markdown') {
      payload.body = wrapEmailHtml(renderMarkdownToHtml(params.body));
    }
    if (params.metadata) payload.metadata = params.metadata;

    return this.request<SendEmailResponse>('/send', payload);
  }

  /**
   * Track an event for a contact.
   */
  async track(params: TrackEventParams): Promise<TrackEventResponse> {
    const payload: Record<string, any> = {
      event: params.event,
      email: params.email,
    };

    if (params.data) payload.data = params.data;

    // `/track` authenticates with the public key (`pk_*`), not the secret key.
    return this.request<TrackEventResponse>('/track', payload, this.publicApiKey);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async request<T>(
    path: string,
    body: Record<string, any>,
    apiKey: string = this.apiKey,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      const message = responseBody?.error || responseBody?.message || `Plunk API error (${response.status})`;
      throw new PlunkError(message, response.status, responseBody);
    }

    return responseBody as T;
  }
}

// ============================================================================
// Module-level convenience exports
// (used by the app — the PlunkClient class above stays dependency-free)
// ============================================================================

import 'dotenv/config';

const apiKey = process.env.PLUNK_API_KEY;
const publicApiKey = process.env.PLUNK_PUBLIC_API_KEY;

if (!apiKey) {
  console.warn('Warning: Missing PLUNK_API_KEY environment variable');
}

if (!publicApiKey) {
  console.warn(
    'Warning: Missing PLUNK_PUBLIC_API_KEY environment variable — event tracking (/track) will fail with 401 unless PLUNK_API_KEY is itself a public (pk_*) key',
  );
}

/** Singleton PlunkClient instance — undefined if PLUNK_API_KEY is not set */
export const plunkClient = apiKey ? new PlunkClient(apiKey, {
  publicApiKey,
  defaultFrom: process.env.PLUNK_DEFAULT_FROM || 'notifications@hilaq.com',
}) : undefined;

/** Check whether the Plunk client is configured */
export function isConfigured(): boolean {
  return !!plunkClient;
}

/** Send an email via the singleton client. Throws if not configured. */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResponse> {
  if (!plunkClient) {
    throw new PlunkError('Plunk client not configured (missing PLUNK_API_KEY)', 0);
  }
  return plunkClient.send(params);
}

/** Track an event via the singleton client. Throws if not configured. */
export async function trackEvent(params: TrackEventParams): Promise<TrackEventResponse> {
  if (!plunkClient) {
    throw new PlunkError('Plunk client not configured (missing PLUNK_API_KEY)', 0);
  }
  return plunkClient.track(params);
}
