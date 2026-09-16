import { z } from "zod";

// =============================================================================
// Validation Schemas
// =============================================================================

/**
 * Username validation rules:
 * - 3-30 characters
 * - Alphanumeric + underscores only
 * - Must start with a letter
 * - Lowercase only
 */
const usernameRegex = /^[a-z][a-z0-9_]{2,29}$/;

export const authSchemas = {
  // ---------------------------------------------------------------------------
  // Signup
  // ---------------------------------------------------------------------------
  signup: z.object({
    email: z.string().email("Invalid email address"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password must be at most 72 characters"),
    name: z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name must be at most 100 characters"),
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(30, "Username must be at most 30 characters")
      .regex(
        usernameRegex,
        "Username must start with a letter, contain only lowercase letters, numbers, and underscores",
      ),
    account_type: z.enum(["personal", "organization"]).default("personal"),
    ref_code: z.string().max(12).optional(),
    redirect_to: z.string().optional(),
    // NDPR: must be explicitly true — false or omitted fails validation
    consent_given: z.literal(true, {
      message: "You must agree to the Privacy Policy to create an account",
    }),
  }),

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------
  login: z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
  }),

  // ---------------------------------------------------------------------------
  // Password Reset Request
  // ---------------------------------------------------------------------------
  resetPassword: z.object({
    email: z.string().email("Invalid email address"),
  }),

  // ---------------------------------------------------------------------------
  // Password Update (after reset)
  // ---------------------------------------------------------------------------
  updatePassword: z.object({
    access_token: z.string().min(1, "Access token is required"),
    refresh_token: z.string().min(1, "Refresh token is required"),
    new_password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password must be at most 72 characters"),
  }),

  // ---------------------------------------------------------------------------
  // Session Refresh
  // ---------------------------------------------------------------------------
  refreshSession: z
    .object({
      refresh_token: z.string().min(1, "Refresh token is required").optional(),
    })
    .default({}),

  // ---------------------------------------------------------------------------
  // Check Username (query params)
  // ---------------------------------------------------------------------------
  checkUsername: z.object({
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(30, "Username must be at most 30 characters")
      .regex(
        usernameRegex,
        "Username must start with a letter, contain only lowercase letters, numbers, and underscores",
      ),
  }),

  // ---------------------------------------------------------------------------
  // Google OAuth Initiation (query params)
  // ---------------------------------------------------------------------------
  googleAuth: z.object({
    redirect: z.string().optional().default("/dashboard"),
    account_type: z
      .enum(["personal", "organization"])
      .optional()
      .default("personal"),
  }),

  // ---------------------------------------------------------------------------
  // Google OAuth Token Processing (body from fragment extraction)
  // ---------------------------------------------------------------------------
  googleProcess: z.object({
    access_token: z.string().min(1, "Access token is required"),
    refresh_token: z.string().optional(),
    next: z.string().optional(),
    account_type: z.enum(["personal", "organization"]).optional(),
    ref_code: z.string().optional(),
  }),

  // ---------------------------------------------------------------------------
  // Account Information Update
  // ---------------------------------------------------------------------------
  updateEmail: z.object({
    new_email: z.string().email("Invalid email address"),
  }),

  updatePasswordDirect: z.object({
    old_password: z.string().min(1, "Old password is required"),
    new_password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(72, "Password must be at most 72 characters"),
  }),
};

// =============================================================================
// Type Exports
// =============================================================================

export type SignupInput = z.infer<typeof authSchemas.signup>;
export type LoginInput = z.infer<typeof authSchemas.login>;
export type ResetPasswordInput = z.infer<typeof authSchemas.resetPassword>;
export type UpdatePasswordInput = z.infer<typeof authSchemas.updatePassword>;
export type RefreshSessionInput = z.infer<typeof authSchemas.refreshSession>;
export type CheckUsernameInput = z.infer<typeof authSchemas.checkUsername>;
export type GoogleAuthInput = z.infer<typeof authSchemas.googleAuth>;
export type GoogleProcessInput = z.infer<typeof authSchemas.googleProcess>;

// =============================================================================
// Response Types
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  pending_email?: string | null;
  email_change_pending?: boolean;
  name: string;
  username: string;
  account_type: "personal" | "organization";
  bio?: string;
  location?: string;
  website?: string;
  avatar_url?: string;
  created_at?: string;
  phone_number?: string;
  tipping_enabled?: boolean;
  preferences?: {
    onboarding_role?: "consumer" | "creator";
    onboarding_completed?: boolean;
    [key: string]: any;
  };
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
}

export interface SignupResponse {
  success: true;
  message: string;
  user: Pick<AuthUser, "id" | "email" | "name" | "username">;
}

export interface LoginResponse {
  success: true;
  user: AuthUser;
}

export interface SessionResponse {
  success: true;
  user: AuthUser;
  session: {
    expires_at: number;
    is_valid: boolean;
  };
}

export interface RefreshResponse {
  success: true;
  session: {
    expires_at: number;
    is_valid: boolean;
  };
}

export interface CheckUsernameResponse {
  available: boolean;
  username: string;
}
