import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../auth/server.js";
import { withIdentity } from "../db/principal.js";
import { authRequiredError } from "../shared/errors.js";

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext | null;
    }
  }
}

interface RawSession {
  session: { id: string };
  user: { id: string; email: string; emailVerified: boolean };
}

async function resolveAuth(request: Request): Promise<AuthContext | null> {
  const session = (await getAuth().api.getSession({
    headers: fromNodeHeaders(request.headers),
  })) as RawSession | null;
  return session
    ? {
        userId: session.user.id,
        sessionId: session.session.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      }
    : null;
}

function applyAuthContext(request: Request, context: AuthContext | null): void {
  request.auth = context;
  if (context) {
    request.principal = withIdentity(
      request.requestId,
      context.userId,
      null,
    );
  }
}

export function initializeAuthContext(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  request.auth = null;
  next();
}

export async function optionalAuth(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    applyAuthContext(request, await resolveAuth(request));
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await resolveAuth(request);
    if (!context) {
      next(authRequiredError());
      return;
    }
    applyAuthContext(request, context);
    next();
  } catch (error) {
    next(error);
  }
}
