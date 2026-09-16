/**
 * Authentication Routes
 *
 * All authentication endpoints for the Hilaq platform.
 * Note: Most routes are public (no auth required) since they handle login/signup.
 */

import { Router } from "express";
import { validateRequest } from "../middleware/validation.middleware";
import { authSchemas } from "../types/auth.schemas";
import { authController } from "../controllers/auth.controller";

const router = Router();

// =============================================================================
// Email/Password Authentication
// =============================================================================

/**
 * POST /api/auth/signup
 * Create a new user account with email and password
 */
router.post(
  "/signup",
  validateRequest(authSchemas.signup, "body"),
  authController.signup.bind(authController),
);

/**
 * POST /api/auth/login
 * Authenticate with email and password
 */
router.post(
  "/login",
  validateRequest(authSchemas.login, "body"),
  authController.login.bind(authController),
);

/**
 * POST /api/auth/logout
 * Sign out and invalidate session
 * Note: Auth is optional - clears cookies even without valid token
 */
router.post("/logout", authController.logout.bind(authController));

// =============================================================================
// Password Management
// =============================================================================

/**
 * POST /api/auth/reset-password
 * Request a password reset email
 */
router.post(
  "/reset-password",
  validateRequest(authSchemas.resetPassword, "body"),
  authController.requestPasswordReset.bind(authController),
);

/**
 * POST /api/auth/update-password
 * Update password using tokens from reset link
 */
router.post(
  "/update-password",
  validateRequest(authSchemas.updatePassword, "body"),
  authController.updatePassword.bind(authController),
);

// =============================================================================
// Session Management
// =============================================================================

/**
 * GET /api/auth/session
 * Get current session info (requires auth header)
 */
router.get("/session", authController.getSession.bind(authController));

/**
 * POST /api/auth/refresh
 * Refresh session using refresh token
 */
router.post(
  "/refresh",
  validateRequest(authSchemas.refreshSession, "body"),
  authController.refreshSession.bind(authController),
);

/**
 * GET /api/auth/passkey/session
 * Returns raw session tokens so the browser can hydrate a Supabase client
 * for the WebAuthn passkey ceremony. Relies on the httpOnly refresh cookie.
 */
router.get(
  "/passkey/session",
  authController.getPasskeySession.bind(authController),
);

// =============================================================================
// Username Availability
// =============================================================================

/**
 * GET /api/auth/check-username?username=johndoe
 * Check if a username is available
 */
router.get(
  "/check-username",
  validateRequest(authSchemas.checkUsername, "query"),
  authController.checkUsername.bind(authController),
);

// =============================================================================
// Google OAuth
// =============================================================================

/**
 * GET /api/auth/google
 * Initiate Google OAuth flow
 * Query params: ?redirect=/dashboard&account_type=personal
 */
router.get(
  "/google",
  validateRequest(authSchemas.googleAuth, "query"),
  authController.initiateGoogleAuth.bind(authController),
);

/**
 * GET /api/auth/google/callback
 * Handle Google OAuth callback - serves HTML page to extract tokens from fragment
 */
router.get(
  "/google/callback",
  authController.handleGoogleCallback.bind(authController),
);

/**
 * POST /api/auth/google/process
 * Process OAuth tokens extracted from URL fragment
 */
router.post(
  "/google/process",
  validateRequest(authSchemas.googleProcess, "body"),
  authController.processGoogleTokens.bind(authController),
);

export default router;
