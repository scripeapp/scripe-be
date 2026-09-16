/**
 * Authentication Controller
 *
 * HTTP handlers for all authentication endpoints.
 * Uses AuthService for business logic and sets cookies for frontend SSR compatibility.
 */

import { Request, Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { authService } from "../services/auth.service";
import { emailService } from "../services/email.service";
import { scheduledEmailService } from "../services/scheduled-email.service";
import { verificationEmail, welcomeEmail } from "../utils/emailsTemplate";
import { trackEvent, isConfigured } from "../config/plunk";
import { supabaseAdmin } from "../config/supabase";
import {
  SignupInput,
  LoginInput,
  ResetPasswordInput,
  UpdatePasswordInput,
  RefreshSessionInput,
  CheckUsernameInput,
  GoogleAuthInput,
  AuthSession,
} from "../types/auth.schemas";

// =============================================================================
// Hilaq platform newsletter publication ID
// =============================================================================
const HILAQ_PUBLICATION_ID =
  process.env.HILAQ_PUBLICATION_ID || "e90260b6-7f3e-4355-9917-f3ce50b5ec50";

/**
 * Silently subscribe a new user to the Hilaq platform newsletter (free plan).
 * Idempotent — safe to call even if the subscription already exists.
 */
async function subscribeToHilaqNewsletter(userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from("subscriptions").insert({
      user_id: userId,
      publication_id: HILAQ_PUBLICATION_ID,
      subscription_type: "free",
      plan: null,
      status: "active",
      current_period_end: null,
      subscribed_at: new Date().toISOString(),
    });
  } catch {
    // Duplicate key (user already subscribed) or any other error — swallow silently
  }
}

// =============================================================================
// Auth Controller Class
// =============================================================================

class AuthController {
  /**
   * Refresh a session from a refresh token and write the rotated tokens back
   * to the httpOnly auth cookies. Shared by POST /auth/refresh and
   * GET /auth/passkey/session so the two refresh paths can never drift on
   * cookie attributes or token-rotation behaviour.
   */
  private async refreshAndSyncCookies(
    refresh_token: string,
    res: Response,
  ): Promise<AuthSession> {
    const session = await authService.refreshSession(refresh_token);
    const cookies = authService.createAuthCookies(session);
    for (const cookie of cookies) {
      res.cookie(cookie.name, cookie.value, cookie.options);
    }
    return session;
  }

  // ---------------------------------------------------------------------------
  // Sign Up
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/signup
   * Create a new user account
   */
  async signup(req: Request, res: Response) {
    try {
      const data = req.body as SignupInput;
      const consentIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip;

      // Create user (validates username/email availability internally)
      const user = await authService.createUser(data, consentIp);

      // Generate verification link and send verification email
      try {
        const verificationLink =
          await authService.generateEmailVerificationLink(
            user.email,
            data.redirect_to,
          );
        await emailService.send({
          to: user.email,
          subject: "Verify Your Email - Hilaq",
          body: verificationEmail({
            name: user.name,
            verificationLink,
          }),
          type: "platform",
        });
      } catch (emailError) {
        console.error(
          "[AuthController] Verification email failed:",
          emailError,
        );
        // Don't fail signup if email fails - user can request resend
      }

      // Send CEO personal welcome email (scheduled with 2h delay)
      try {
        const twoHoursLater = new Date();
        twoHoursLater.setHours(twoHoursLater.getHours() + 2);

        await scheduledEmailService.schedule({
          to: user.email,
          subject: "Welcome to Hilaq!",
          body: welcomeEmail({ name: user.name }),
          type: "platform",
          scheduledAt: twoHoursLater,
        });
      } catch (emailError) {
        console.error("[AuthController] Welcome email scheduling failed:", emailError);
      }

      // Auto-subscribe new user to the Hilaq platform newsletter (non-blocking)
      subscribeToHilaqNewsletter(user.id).catch((err) =>
        console.error("[AuthController] Hilaq newsletter subscription failed:", err),
      );

      // Add new user to Plunk contacts so they receive Hilaq newsletter campaigns (non-blocking)
      if (isConfigured()) {
        trackEvent({
          event: "user-signup",
          email: user.email,
          data: { name: user.name || "" },
        }).catch((err) =>
          console.error("[AuthController] Plunk contact creation failed:", err),
        );
      }

      // Partner referral attribution (non-blocking)
      if (data.ref_code) {
        try {
          const { PartnerService } =
            await import("../services/partner.service");
          const { supabaseAdmin, SUPABASE_PROJECT_ID } =
            await import("../config/supabase");
          const partnerService = new PartnerService(
            supabaseAdmin || req.app.locals.supabase,
          );
          await partnerService.attributeSignup(
            data.ref_code,
            user.id,
            user.email,
          );
        } catch (refErr) {
          console.error("[AuthController] Partner attribution failed:", refErr);
        }
      }

      return ApiResponse.created(
        res,
        "Account created. Please check your email to verify your account.",
        {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            username: user.username,
          },
        },
      );
    } catch (error: any) {
      console.error("[AuthController] Signup error:", error);

      // Pass through user-friendly error messages from the service
      if (error.code === "USERNAME_TAKEN") {
        return ApiResponse.badRequest(res, error.message);
      }
      if (error.code === "EMAIL_EXISTS") {
        return ApiResponse.conflict(res, error.message);
      }
      if (error.code === "WEAK_PASSWORD") {
        return ApiResponse.badRequest(res, error.message);
      }
      if (error.code === "DB_ERROR" || error.code === "AUTH_ERROR") {
        return ApiResponse.serverError(res, error.message);
      }

      // Generic fallback for unexpected errors
      return ApiResponse.serverError(
        res,
        "Something went wrong. Please try again later.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/login
   * Authenticate with email and password
   */
  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body as LoginInput;

      const { user, session } = await authService.signInWithPassword(
        email,
        password,
      );

      // Set auth cookies for frontend SSR compatibility
      const cookies = authService.createAuthCookies(session, user);
      for (const cookie of cookies) {
        res.cookie(cookie.name, cookie.value, cookie.options);
      }

      return ApiResponse.success(res, "Login successful", { user });
    } catch (error: any) {
      console.error("[AuthController] Login error:", error);

      if (error.code === "EMAIL_NOT_VERIFIED") {
        return ApiResponse.forbidden(res, error.message);
      }
      if (error.code === "INVALID_CREDENTIALS") {
        return ApiResponse.unauthorized(res, error.message);
      }

      // Generic fallback for unexpected errors
      return ApiResponse.serverError(
        res,
        "We couldn't sign you in right now. Please try again later.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/logout
   * Sign out and clear session
   */
  async logout(req: Request, res: Response) {
    try {
      const authHeader = req.headers.authorization;
      const accessToken = authHeader?.replace("Bearer ", "");

      if (accessToken) {
        await authService.signOut(accessToken);
      }

      // Clear auth cookies
      const clearCookies = authService.createClearCookies();
      for (const cookie of clearCookies) {
        res.cookie(cookie.name, cookie.value, cookie.options);
      }

      return ApiResponse.success(res, "Logged out successfully", null);
    } catch (error: any) {
      console.error("[AuthController] Logout error:", error);
      // Still clear cookies even if signOut fails
      const clearCookies = authService.createClearCookies();
      for (const cookie of clearCookies) {
        res.cookie(cookie.name, cookie.value, cookie.options);
      }
      return ApiResponse.success(res, "Logged out successfully", null);
    }
  }

  // ---------------------------------------------------------------------------
  // Password Reset
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/reset-password
   * Request a password reset email
   */
  async requestPasswordReset(req: Request, res: Response) {
    try {
      const { email } = req.body as ResetPasswordInput;

      await authService.requestPasswordReset(email);

      // Always return success for security (don't reveal if email exists)
      return ApiResponse.success(
        res,
        "If an account exists with this email, a password reset link has been sent.",
        null,
      );
    } catch (error: any) {
      console.error("[AuthController] Password reset request error:", error);
      // Still return success for security
      return ApiResponse.success(
        res,
        "If an account exists with this email, a password reset link has been sent.",
        null,
      );
    }
  }

  /**
   * POST /api/auth/update-password
   * Update password using reset token
   */
  async updatePassword(req: Request, res: Response) {
    try {
      const { access_token, refresh_token, new_password } =
        req.body as UpdatePasswordInput;

      await authService.updatePassword(
        access_token,
        refresh_token,
        new_password,
      );

      return ApiResponse.success(
        res,
        "Password updated successfully. Please log in with your new password.",
        null,
      );
    } catch (error: any) {
      console.error("[AuthController] Password update error:", error);

      if (error.code === "INVALID_TOKEN") {
        return ApiResponse.badRequest(res, error.message);
      }

      return ApiResponse.serverError(res, error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * GET /api/auth/session
   * Get current session info
   */
  async getSession(req: Request, res: Response) {
    try {
      const authHeader = req.headers.authorization;
      let accessToken = authHeader?.replace("Bearer ", "");

      // If no token in header, try extracting from cookies (e.g. cross-subdomain API calls)
      if (!accessToken && req.headers.cookie) {
        const cookieValue = authService.extractAuthCookieValue(req.headers.cookie);

        if (cookieValue) {
          accessToken = authService.extractAccessTokenFromCookieValue(cookieValue) || "";
        }
      }

      if (!accessToken) {
        return ApiResponse.unauthorized(res, "No access token provided");
      }

      const sessionInfo = await authService.getSession(accessToken);

      // Upgrade edge-case: If they had a valid token but no/invalid cookie, set the new cookie
      if (sessionInfo && sessionInfo.is_valid) {
        const cookiesToSet = authService.createAuthCookies(
          {
            access_token: accessToken,
            refresh_token: "", // Will be gracefully handled simply by being empty
            expires_at: sessionInfo.expires_at,
            expires_in: sessionInfo.expires_at - Math.floor(Date.now() / 1000),
            token_type: "bearer",
          } as any,
          sessionInfo.user,
        );
        for (const cookie of cookiesToSet) {
          res.cookie(cookie.name, cookie.value, cookie.options);
        }
      }

      return ApiResponse.success(res, "Session retrieved", {
        user: sessionInfo.user,
        session: {
          expires_at: sessionInfo.expires_at,
          is_valid: sessionInfo.is_valid,
        },
      });
    } catch (error: any) {
      console.error("[AuthController] Get session error:", error);

      if (error.code === "INVALID_SESSION") {
        return ApiResponse.unauthorized(res, error.message);
      }

      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * POST /api/auth/refresh
   * Refresh session tokens
   */
  async refreshSession(req: Request, res: Response) {
    try {
      // Primary: body token (explicit refresh). Fallback: httpOnly cookie (cookie-only auth).
      let refresh_token: string | undefined = (req.body as RefreshSessionInput)?.refresh_token;

      if (!refresh_token && req.headers.cookie) {
        refresh_token =
          authService.extractRefreshTokenCookieValue(req.headers.cookie) ||
          undefined;
      }

      if (!refresh_token) {
        return ApiResponse.unauthorized(res, "No refresh token available");
      }

      const session = await this.refreshAndSyncCookies(refresh_token, res);

      return ApiResponse.success(res, "Session refreshed", {
        session: {
          expires_at: session.expires_at,
          is_valid: true,
        },
      });
    } catch (error: any) {
      console.error("[AuthController] Refresh session error:", error);

      if (error.code === "INVALID_REFRESH_TOKEN") {
        const clearCookies = authService.createClearCookies();
        for (const cookie of clearCookies) {
          res.cookie(cookie.name, cookie.value, cookie.options);
        }
        return ApiResponse.unauthorized(res, error.message);
      }

      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * GET /api/auth/passkey/session
   *
   * Returns the current session's raw access + refresh tokens so the browser
   * can hydrate a (non-persistent) Supabase client for the WebAuthn passkey
   * ceremony. The app's normal session lives in httpOnly cookies that
   * supabase-js cannot read, so passkey register/list/delete would otherwise
   * fail with "Auth session missing". Relies on the httpOnly refresh cookie
   * (same trust model as POST /auth/refresh) and refreshes to guarantee valid
   * tokens, updating cookies in the process.
   */
  async getPasskeySession(req: Request, res: Response) {
    try {
      const refresh_token = req.headers.cookie
        ? authService.extractRefreshTokenCookieValue(req.headers.cookie) ||
          undefined
        : undefined;

      if (!refresh_token) {
        return ApiResponse.unauthorized(res, "No refresh token available");
      }

      // Refresh + keep httpOnly cookies in sync with the rotated session.
      const session = await this.refreshAndSyncCookies(refresh_token, res);

      return ApiResponse.success(res, "Passkey session retrieved", {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      });
    } catch (error: any) {
      console.error("[AuthController] Get passkey session error:", error);

      if (error.code === "INVALID_REFRESH_TOKEN") {
        return ApiResponse.unauthorized(res, error.message);
      }

      return ApiResponse.serverError(res, error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Username Check
  // ---------------------------------------------------------------------------

  /**
   * GET /api/auth/check-username?username=johndoe
   * Check if a username is available
   */
  async checkUsername(req: Request, res: Response) {
    try {
      const { username } = req.query as unknown as CheckUsernameInput;

      const available = await authService.checkUsernameAvailability(username);

      return res.status(200).json({
        available,
        username: username.toLowerCase(),
      });
    } catch (error: any) {
      console.error("[AuthController] Check username error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Google OAuth
  // ---------------------------------------------------------------------------

  /**
   * GET /api/auth/google
   * Initiate Google OAuth flow
   */
  async initiateGoogleAuth(req: Request, res: Response) {
    try {
      const { redirect, account_type } =
        req.query as unknown as GoogleAuthInput;

      const authUrl = await authService.getGoogleAuthUrl(
        redirect || "/dashboard",
        account_type || "personal",
      );

      return res.redirect(authUrl);
    } catch (error: any) {
      console.error("[AuthController] Google OAuth initiation error:", error);
      const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";
      return res.redirect(`${frontendUrl}/auth/login?error=oauth_failed`);
    }
  }

  /**
   * GET /api/auth/google/callback
   * Handle Google OAuth callback
   *
   * Supabase uses implicit flow, so tokens come in URL fragment (#).
   * We serve an HTML page that extracts the fragment and posts to our process endpoint.
   */
  async handleGoogleCallback(req: Request, res: Response) {
    const rawNext = typeof req.query.next === "string" ? req.query.next : "/dashboard";
    const rawAccountType = typeof req.query.account_type === "string" ? req.query.account_type : "personal";

    // Validate same-origin redirect — reject external URLs
    const safeNext = rawNext.startsWith("/") ? rawNext : "/dashboard";

    // Validate account_type — only known values
    const safeAccountType = ["personal", "organization"].includes(rawAccountType) ? rawAccountType : "personal";

    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";
    const backendUrl = process.env.BACKEND_URL || "https://api.hilaq.com";

    const safeNextEscaped = JSON.stringify(safeNext);
    const safeAccountTypeEscaped = JSON.stringify(safeAccountType);
    const frontendEscaped = JSON.stringify(frontendUrl);
    const backendEscaped = JSON.stringify(backendUrl);

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Completing sign in...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container { text-align: center; }
    .spinner {
      width: 40px; height: 40px;
      border: 4px solid rgba(255,255,255,0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p>Completing sign in...</p>
  </div>
  <script>
    (function() {
      var hash = window.location.hash.substring(1);
      if (!hash) {
        window.location.href = ${frontendEscaped} + '/auth/login?error=oauth_failed';
        return;
      }

      var params = new URLSearchParams(hash);
      var accessToken = params.get('access_token');
      var refreshToken = params.get('refresh_token');

      if (!accessToken) {
        window.location.href = ${frontendEscaped} + '/auth/login?error=oauth_failed';
        return;
      }

      fetch(${backendEscaped} + '/api/auth/google/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
          next: ${safeNextEscaped},
          account_type: ${safeAccountTypeEscaped}
        })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          window.location.href = data.data.redirect_url;
        } else {
          window.location.href = ${frontendEscaped} + '/auth/login?error=oauth_failed';
        }
      })
      .catch(function() {
        window.location.href = ${frontendEscaped} + '/auth/login?error=oauth_failed';
      });
    })();
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  }

  /**
   * POST /api/auth/google/process
   * Process OAuth tokens from the client-side fragment extraction
   * Returns user and session in the same format as login endpoint
   */
  async processGoogleTokens(req: Request, res: Response) {
    try {
      const { access_token, refresh_token, next, account_type, ref_code } =
        req.body as {
          access_token: string;
          refresh_token?: string;
          next?: string;
          account_type?: string;
          ref_code?: string;
        };

      if (!access_token) {
        return ApiResponse.badRequest(res, "Access token is required");
      }

      const { user, session, isNewUser, redirectPath } =
        await authService.handleGoogleTokens(
          access_token,
          refresh_token,
          next,
          account_type,
        );

      // Set auth cookies for SSR compatibility
      const cookies = authService.createAuthCookies(session, user);
      for (const cookie of cookies) {
        res.cookie(cookie.name, cookie.value, cookie.options);
      }

      // Send welcome email for new users (scheduled with 2h delay)
      if (isNewUser) {
        try {
          const twoHoursLater = new Date();
          twoHoursLater.setHours(twoHoursLater.getHours() + 2);

          await scheduledEmailService.schedule({
            to: user.email,
            subject: "Welcome to Hilaq!",
            body: welcomeEmail({ name: user.name }),
            type: "platform",
            scheduledAt: twoHoursLater,
          });
        } catch (emailError) {
          console.error("[AuthController] Welcome email scheduling failed:", emailError);
        }

        // Auto-subscribe new user to the Hilaq platform newsletter (non-blocking)
        subscribeToHilaqNewsletter(user.id).catch((err) =>
          console.error("[AuthController] Hilaq newsletter subscription failed (Google):", err),
        );

        // Add new user to Plunk contacts (non-blocking)
        if (isConfigured()) {
          trackEvent({
            event: "user-signup",
            email: user.email,
            data: { name: user.name || "" },
          }).catch((err) =>
            console.error("[AuthController] Plunk contact creation failed (Google):", err),
          );
        }

        // Partner referral attribution (non-blocking)
        if (ref_code) {
          try {
            const { PartnerService } =
              await import("../services/partner.service");
            const { supabaseAdmin } = await import("../config/supabase");
            const partnerService = new PartnerService(
              supabaseAdmin || req.app.locals.supabase,
            );
            await partnerService.attributeSignup(ref_code, user.id, user.email);
          } catch (refErr) {
            console.error(
              "[AuthController] Partner attribution failed during Google signup:",
              refErr,
            );
          }
        }
      }

      return ApiResponse.success(res, "Login successful", {
        user,
        redirectPath,
        isNewUser,
      });
    } catch (error: any) {
      console.error("[AuthController] Google OAuth process error:", error);
      const statusCode = error.statusCode || 500;
      const message = error.message || "An unexpected error occurred during Google sign-in";

      if (statusCode === 400 || statusCode === 409) {
        return ApiResponse.error(res, message, statusCode);
      }

      return ApiResponse.serverError(res, message);
    }
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

export const authController = new AuthController();
export default AuthController;
