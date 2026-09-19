import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

export function attachRequestId(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.header(REQUEST_ID_HEADER);
  const requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
  request.requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
