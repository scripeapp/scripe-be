import { SupabaseClient } from '@supabase/supabase-js';

declare global {
  namespace Express {
    interface Request {
      user_id?: string;
      supabase?: SupabaseClient;
      userProfile?: { name?: string };
    }
  }
}
export type SupabaseRequest = Express.Request & {
  supabase: SupabaseClient;
  user_id?: string;
  userProfile?: { name?: string };
};

export {}; // ensure this file is treated as a module
