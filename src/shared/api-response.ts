import type { Response } from "express";
import type { ErrorPayload } from "./errors.js";

export interface ApiSuccessResponse<T> {
  readonly success: true;
  readonly data: T;
}

export interface ApiErrorResponse {
  readonly success: false;
  readonly error: ErrorPayload;
}

export type ApiResponseBody<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Sends the response envelope used by every application-owned endpoint. */
export class ApiResponse {
  static success<T>(
    response: Response,
    data: T,
    statusCode = 200,
  ): void {
    response.status(statusCode).json({
      success: true,
      data,
    } satisfies ApiSuccessResponse<T>);
  }

  static error(
    response: Response,
    error: ErrorPayload,
    statusCode: number,
  ): void {
    response.status(statusCode).json({
      success: false,
      error,
    } satisfies ApiErrorResponse);
  }
}
