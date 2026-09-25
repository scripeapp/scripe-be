export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "SERVICE_UNAVAILABLE";

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION_ERROR", message, 400, details);
}

export function notFoundError(message = "Resource not found"): AppError {
  return new AppError("NOT_FOUND", message, 404);
}

export function conflictError(message: string): AppError {
  return new AppError("CONFLICT", message, 409);
}

export function forbiddenError(message = "Forbidden"): AppError {
  return new AppError("FORBIDDEN", message, 403);
}

export function authRequiredError(message = "Authentication required"): AppError {
  return new AppError("AUTH_REQUIRED", message, 401);
}

export function serviceUnavailableError(message: string): AppError {
  return new AppError("SERVICE_UNAVAILABLE", message, 503);
}
export function rateLimitedError(message: string): AppError {
  return new AppError("RATE_LIMITED", message, 429);
}
