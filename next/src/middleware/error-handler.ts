import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { DatabaseError } from "../db/errors.js";
import { AppError } from "../shared/errors.js";

export function notFoundHandler(request: Request, _response: Response): void {
  throw new AppError("NOT_FOUND", `Route not found: ${request.method} ${request.path}`, 404);
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const context = { requestId: request.requestId, method: request.method, path: request.path };

  if (error instanceof AppError) {
    response.status(error.statusCode).json(error.toPayload());
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof DatabaseError) {
    const isConflict = error.kind === "unique-violation";
    const isInvalidInput =
      error.kind === "foreign-key-violation" || error.kind === "check-violation";
    const status = isConflict ? 409 : isInvalidInput ? 400 : 503;
    const code = isConflict
      ? "CONFLICT"
      : isInvalidInput
        ? "VALIDATION_ERROR"
        : "SERVICE_UNAVAILABLE";
    response.status(status).json({ code, message: error.message });
    return;
  }

  console.error("[error] unhandled", context, error);
  response.status(500).json({
    code: "INTERNAL",
    message: "An unexpected error occurred",
  });
}
