/**
 * Plunk configuration
 *
 * Re-exports the PlunkClient and convenience functions from src/lib/plunk.
 * This file exists for backward-compatible import paths:
 *   import { sendEmail, isConfigured } from '../config/plunk';
 */

export {
  PlunkClient,
  PlunkError,
  plunkClient,
  isConfigured,
  sendEmail,
  trackEvent,
} from '../lib/plunk';

export type {
  PlunkClientOptions,
  SendEmailParams,
  SendEmailResponse,
  TrackEventParams,
  TrackEventResponse,
} from '../lib/plunk';
