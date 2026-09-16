import { Response } from "express";

/**
 * Standardized API response handler
 */
export class ApiResponse {
  /**
   * Success response with 200 status code
   */
  static success(res: Response, message: string, data: unknown = null) {
    return res.status(200).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Created response with 201 status code
   */
  static created(res: Response, message: string, data: unknown = null) {
    return res.status(201).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Bad request response with 400 status code
   */
  static badRequest(res: Response, message: string) {
    return res.status(400).json({
      success: false,
      error: message,
    });
  }

  /**
   * Unauthorized response with 401 status code
   */
  static unauthorized(res: Response, message = "Unauthorized access") {
    return res.status(401).json({
      success: false,
      error: message,
    });
  }

  /**
   * Forbidden response with 403 status code
   */
  static forbidden(res: Response, message = "Access forbidden") {
    return res.status(403).json({
      success: false,
      error: message,
    });
  }

  /**
   * Not found response with 404 status code
   */
  static notFound(res: Response, message = "Resource not found") {
    return res.status(404).json({
      success: false,
      error: message,
    });
  }

  /**
   * Conflict response with 409 status code
   */
  static conflict(res: Response, message = "Resource already exists") {
    return res.status(409).json({
      success: false,
      error: message,
    });
  }

  /**
   * Server error response with 500 status code
   */
  static serverError(res: Response, message = "Internal server error") {
    return res.status(500).json({
      success: false,
      error: message,
      details: process.env.NODE_ENV === "development" ? message : undefined,
    });
  }

  /**
   * Generic error response with custom status code.
   * `details` carries machine-readable context (e.g. remaining PIN attempts)
   * without changing the error shape clients already depend on.
   */
  static error(
    res: Response,
    message: string,
    statusCode: number = 400,
    details?: Record<string, unknown>,
  ) {
    return res.status(statusCode).json({
      success: false,
      error: message,
      ...(details ? { details } : {}),
    });
  }
}

export default ApiResponse;
