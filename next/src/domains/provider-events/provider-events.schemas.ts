/**
 * No Zod contracts here — a webhook's shape is dictated by the provider,
 * not by this backend, so validating it against our own schema would
 * mean guessing at (and rejecting real deliveries over) fields providers
 * are free to add or omit. provider-events.service.ts defensively reads
 * only the specific fields each handler needs (see asString/asRecord).
 */
export {};
