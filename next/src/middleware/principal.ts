import type { Request, Response, NextFunction } from "express";
import type { Principal } from "../db/principal.js";
import { anonymousPrincipal } from "../db/principal.js";

declare global {
  namespace Express {
    interface Request {
      principal: Principal;
    }
  }
}

export function attachPrincipal(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  // Map the authenticated identity onto the principal once auth is mounted.
  // Until then every request is anonymous; RLS never inherits a prior identity.
  request.principal = anonymousPrincipal(request.requestId);
  next();
}
