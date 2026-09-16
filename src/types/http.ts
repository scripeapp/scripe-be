import { RequestHandler, Request, Response, NextFunction } from 'express';
import { SupabaseClient, User } from '@supabase/supabase-js';
import { AdminUser } from '../services/admin.service';

// Strongly typed Request that includes Supabase augmentation
export type SupabaseRequest = Request & {
  supabase: SupabaseClient;
  user_id?: string;
user?: User;
  access_token?: string;
  businessId?: string;
  userProfile?: { name?: string };
  admin?: AdminUser;
  // Set by authenticateUserOrRegisterDevice when a paired POS device (not a
  // logged-in dashboard user) made the request.
  deviceRegister?: { id: string; store_id: string; branch_id: string | null };
  /** Set by authenticateCheckinOrUser when a valid check-in token is used instead of a user session. */
  checkinEventId?: string;
};

// Controller handlers that expect a SupabaseRequest
export type SupabaseRequestHandler = (req: SupabaseRequest, res: Response, next?: NextFunction) => any;

// Adapter to bridge Express RequestHandler to our SupabaseRequest-based handlers
export function withSupabase(handler: SupabaseRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    return Promise.resolve(handler(req as SupabaseRequest, res, next)).catch(next);
  };
}
