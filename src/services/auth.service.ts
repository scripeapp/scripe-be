/**
 * Authentication Service
 *
 * Handles all authentication operations using Supabase Admin SDK (v2).
 * Sets Supabase SSR-compatible cookies for frontend middleware compatibility.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import {
  supabaseAdmin,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_PROJECT_ID,
} from "../config/supabase";
import { SignupInput, AuthUser, AuthSession } from "../types/auth.schemas";

// =============================================================================
// Types
// =============================================================================

interface Cookie {
  name: string;
  value: string;
  options: {
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "lax" | "strict" | "none";
    maxAge?: number;
    domain?: string;
  };
}

// =============================================================================
// Auth Service Class
// =============================================================================

class AuthService {
  private supabase: SupabaseClient;
  private projectRef: string;
  private readonly refreshRequests = new Map<string, Promise<AuthSession>>();
  private readonly MAX_COOKIE_NAME_VALUE_SIZE = 4096;
  private readonly COOKIE_TOKEN_PREFIX = "t:";
  private readonly REFRESH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
  private readonly PREFERENCE_DEFAULTS = {
    timezone: "Africa/Lagos",
    currency: "NGN",
    locale: "en",
    theme: "light",
    onboarding_completed: false,
  };

  constructor() {
    this.supabase = supabaseAdmin;
    // Extract project ref dynamically from URL to avoid undefined imports during circular loads
    this.projectRef =
      process.env.SUPABASE_PROJECT_ID ||
      new URL(SUPABASE_URL as string).hostname.split(".")[0];
  }

  /**
   * Check if a username is available
   */
  async checkUsernameAvailability(username: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("users")
      .select("id")
      .eq("username", username.toLowerCase())
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") {
      return true;
    }

    if (error) {
      throw error;
    }

    return !data;
  }

  /**
   * Generate a unique username from a base name
   * Used primarily for OAuth signups where username isn't provided
   */
  async generateUsername(baseName: string): Promise<string> {
    // Normalize: lowercase, remove spaces and special chars, keep alphanumeric + underscores
    let base = baseName
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_]/g, "");

    // Ensure it starts with a letter
    if (!/^[a-z]/.test(base)) {
      base = "user" + base;
    }

    // Truncate to leave room for counter
    base = base.substring(0, 25);

    let username = base;
    let counter = 1;

    while (!(await this.checkUsernameAvailability(username))) {
      username = `${base}${counter}`;
      counter++;

      // Safety limit to prevent infinite loop
      if (counter > 1000) {
        username = `${base}${Date.now().toString(36)}`;
        break;
      }
    }

    return username;
  }

  /**
   * Create a new user with email/password (v2 Admin API)
   */
  async createUser(data: SignupInput, consentIp?: string): Promise<AuthUser> {
    // 1. Check username availability
    const isAvailable = await this.checkUsernameAvailability(data.username);
    if (!isAvailable) {
      throw Object.assign(
        new Error(
          "This username is already taken. Please choose a different one.",
        ),
        {
          code: "USERNAME_TAKEN",
          statusCode: 400,
        },
      );
    }

    // 2. Check email availability in users table
    const { data: existingUser } = await this.supabase
      .from("users")
      .select("id")
      .eq("email", data.email.toLowerCase())
      .limit(1)
      .single();

    if (existingUser) {
      throw Object.assign(
        new Error(
          "An account with this email already exists. Please sign in or use a different email.",
        ),
        {
          code: "EMAIL_EXISTS",
          statusCode: 409,
        },
      );
    }

    // 3. Check if email already exists in Supabase Auth (orphaned auth user)
    //    This can happen if a previous signup failed after auth creation but before DB insert
    let existingAuthUserId: string | null = null;
    try {
      const { data: authUsers } = await this.supabase.auth.admin.listUsers();
      const existingAuthUser = authUsers?.users?.find(
        (u) => u.email?.toLowerCase() === data.email.toLowerCase(),
      );
      if (existingAuthUser) {
        existingAuthUserId = existingAuthUser.id;
        console.log(
          "[AuthService] Found orphaned auth user, will delete:",
          existingAuthUserId,
        );
        // Delete the orphaned auth user so we can create a fresh one
        await this.supabase.auth.admin.deleteUser(existingAuthUserId);
      }
    } catch (listError) {
      console.error(
        "[AuthService] Error checking for orphaned auth user:",
        listError,
      );
      // Continue anyway - createUser will fail if there's a conflict
    }

    // 4. Create user in Supabase Auth using Admin API (v2)
    const { data: authData, error: authError } =
      await this.supabase.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: false, // User must verify email
        user_metadata: {
          name: data.name,
          username: data.username,
          account_type: data.account_type,
        },
      });

    if (authError) {
      console.error("[AuthService] Supabase auth error:", authError);

      // Provide user-friendly messages for common auth errors
      if (authError.message.includes("already been registered")) {
        throw Object.assign(
          new Error(
            "An account with this email already exists. Please sign in or use a different email.",
          ),
          {
            code: "EMAIL_EXISTS",
            statusCode: 409,
          },
        );
      }
      if (authError.message.toLowerCase().includes("password")) {
        throw Object.assign(
          new Error(
            "Your password doesn't meet our security requirements. Please use at least 8 characters.",
          ),
          {
            code: "WEAK_PASSWORD",
            statusCode: 400,
          },
        );
      }

      throw Object.assign(
        new Error(
          "We couldn't create your account right now. Please try again in a few moments.",
        ),
        {
          code: "AUTH_ERROR",
          statusCode: 400,
        },
      );
    }

    if (!authData?.user) {
      throw Object.assign(
        new Error(
          "We couldn't create your account right now. Please try again in a few moments.",
        ),
        {
          code: "AUTH_ERROR",
          statusCode: 500,
        },
      );
    }

    const userId = authData.user.id;

    // 5. Insert into users table
    const onboardingRole =
      data.account_type === "organization" ? "creator" : "consumer";

    const { error: insertError } = await this.supabase.from("users").insert([
      {
        id: userId,
        email: data.email.toLowerCase(),
        name: data.name,
        username: data.username.toLowerCase(),
        account_type: data.account_type,
        consent_given: true,
        consent_date: new Date().toISOString(),
        consent_ip: consentIp ?? null,
        consent_version: "privacy-policy-v1",
        preferences: {
          onboarding_role: onboardingRole,
          onboarding_completed: false,
        },
      },
    ]);

    if (insertError) {
      // Rollback: delete auth user if DB insert fails
      console.error("[AuthService] Users table insert failed:", insertError);
      await this.supabase.auth.admin.deleteUser(userId);
      throw Object.assign(
        new Error(
          "We couldn't complete your registration. Please try again or contact support if the issue persists.",
        ),
        {
          code: "DB_ERROR",
          statusCode: 500,
        },
      );
    }

    return {
      id: userId,
      email: data.email,
      name: data.name,
      username: data.username.toLowerCase(),
      account_type: data.account_type,
      preferences: {
        ...this.PREFERENCE_DEFAULTS,
        onboarding_role: onboardingRole,
      },
    };
  }

  /**
   * Helper to merge database preferences with defaults
   */
  private mergePreferences(userPrefs: any): any {
    const prefs = userPrefs || {};
    return {
      ...this.PREFERENCE_DEFAULTS,
      ...prefs,
    };
  }

  /**
   * Generate an email verification link for a user
   * Uses Supabase Admin API to create a magic link for email verification
   */
  async generateEmailVerificationLink(
    email: string,
    redirectTo?: string,
  ): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";

    const { data, error } = await this.supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: redirectTo
          ? `${frontendUrl}/auth/verified?next=${encodeURIComponent(redirectTo)}`
          : `${frontendUrl}/auth/verified`,
      },
    });

    if (error) {
      console.error(
        "[AuthService] Failed to generate verification link:",
        error,
      );
      throw Object.assign(new Error("Failed to generate verification link"), {
        code: "VERIFICATION_LINK_ERROR",
        statusCode: 500,
      });
    }

    // The link contains a token that verifies the email when clicked
    return data.properties.action_link;
  }

  /**
   * Resend email verification link
   */
  async resendVerificationEmail(email: string): Promise<string> {
    // Check if user exists
    const { data: user } = await this.supabase
      .from("users")
      .select("id, name")
      .eq("email", email.toLowerCase())
      .single();

    if (!user) {
      // Don't reveal if email exists for security
      throw Object.assign(
        new Error(
          "If an account exists with this email, a verification link has been sent.",
        ),
        {
          code: "EMAIL_NOT_FOUND",
          statusCode: 200, // Return 200 for security
        },
      );
    }

    const link = await this.generateEmailVerificationLink(email);
    return link;
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Sign in with email and password (v2 API)
   */
  async signInWithPassword(
    email: string,
    password: string,
  ): Promise<{ user: AuthUser; session: AuthSession }> {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      // Check for specific error types and provide friendly messages
      if (error.message.includes("Email not confirmed")) {
        throw Object.assign(
          new Error(
            "Please verify your email before signing in. Check your inbox for the verification link.",
          ),
          {
            code: "EMAIL_NOT_VERIFIED",
            statusCode: 403,
          },
        );
      }
      throw Object.assign(
        new Error(
          "The email or password you entered is incorrect. Please try again.",
        ),
        {
          code: "INVALID_CREDENTIALS",
          statusCode: 401,
        },
      );
    }

    if (!data.session || !data.user) {
      throw Object.assign(
        new Error("We couldn't sign you in right now. Please try again."),
        {
          code: "AUTH_FAILED",
          statusCode: 401,
        },
      );
    }

    // Fetch user profile from users table
    const { data: profile, error: profileError } = await this.supabase
      .from("users")
      .select(
        "name, username, account_type, preferences, bio, location, website, avatar_url, created_at, tipping_enabled, phone_number",
      )
      .eq("id", data.user.id)
      .single();

    if (profileError) {
      console.error("[AuthService] Profile fetch failed:", profileError);
    }

    const user: AuthUser = {
      id: data.user.id,
      email: data.user.email || email,
      name: profile?.name || data.user.user_metadata?.name || "",
      username: profile?.username || data.user.user_metadata?.username || "",
      account_type:
        profile?.account_type ||
        data.user.user_metadata?.account_type ||
        "personal",
      bio: profile?.bio,
      location: profile?.location,
      website: profile?.website,
      avatar_url: profile?.avatar_url,
      created_at: profile?.created_at || data.user.created_at,
      phone_number: profile?.phone_number,
      tipping_enabled: profile?.tipping_enabled,
      preferences: this.mergePreferences(
        profile?.preferences || data.user.user_metadata?.preferences,
      ),
    };

    const session: AuthSession = {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at || 0,
      expires_in: data.session.expires_in || 3600,
      token_type: data.session.token_type || "bearer",
    };

    return { user, session };
  }

  /**
   * Sign out a user (v2 API)
   */
  async signOut(accessToken: string): Promise<void> {
    // Verify the token first using v2 API
    const { data: userData, error: userError } =
      await this.supabase.auth.getUser(accessToken);

    if (userError || !userData.user) {
      throw Object.assign(
        new Error("Your session has expired. Please sign in again."),
        {
          code: "INVALID_SESSION",
          statusCode: 401,
        },
      );
    }

    // Sign out using v2 admin API - signOut() with scope 'global' signs out all sessions
    const { error } = await this.supabase.auth.signOut({ scope: "global" });

    if (error) {
      console.error("[AuthService] Sign out error:", error);
      // Don't throw - user may just want to clear cookies
    }
  }

  // ---------------------------------------------------------------------------
  // Password Management
  // ---------------------------------------------------------------------------

  /**
   * Request a password reset email (v2 API)
   */
  async requestPasswordReset(email: string): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";

    const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontendUrl}/auth/update-password`,
    });

    if (error) {
      console.error("[AuthService] Password reset error:", error);
      // Don't throw - for security, always return success
    }
  }

  /**
   * Update password using tokens from reset link (v2 API)
   */
  async updatePassword(
    accessToken: string,
    refreshToken: string,
    newPassword: string,
  ): Promise<void> {
    // Set the session from the tokens
    const { data: sessionData, error: sessionError } =
      await this.supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

    if (sessionError || !sessionData.session) {
      throw Object.assign(
        new Error(
          "Your password reset link has expired or is invalid. Please request a new one.",
        ),
        {
          code: "INVALID_TOKEN",
          statusCode: 400,
        },
      );
    }

    // Update the password using v2 API
    const { error: updateError } = await this.supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      throw Object.assign(
        new Error(
          "We couldn't update your password. Please make sure it meets our security requirements.",
        ),
        {
          code: "PASSWORD_UPDATE_FAILED",
          statusCode: 400,
        },
      );
    }

    // Sign out all sessions for security
    await this.supabase.auth.signOut({ scope: "global" });
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Get session information from access token (v2 API)
   */
  async getSession(accessToken: string): Promise<{
    user: AuthUser;
    expires_at: number;
    is_valid: boolean;
  }> {
    const { data, error } = await this.supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      throw Object.assign(
        new Error("Your session has expired. Please sign in again."),
        {
          code: "INVALID_SESSION",
          statusCode: 401,
        },
      );
    }

    // Fetch user profile
    const { data: profile } = await this.supabase
      .from("users")
      .select("*")
      .eq("id", data.user.id)
      .single();

    // Keep profile email synced to auth email (auth is source of truth).
    const authEmail = (data.user.email || "").toLowerCase();
    const pendingEmailFromAuth =
      ((data.user as any)?.new_email as string | undefined)?.toLowerCase() ||
      ((data.user as any)?.email_change as string | undefined)?.toLowerCase() ||
      null;
    const profileEmail = (profile?.email || "").toLowerCase();
    if (authEmail && profileEmail && authEmail !== profileEmail) {
      const { error: syncEmailError } = await this.supabase
        .from("users")
        .update({ email: authEmail })
        .eq("id", data.user.id);
      if (!syncEmailError) {
        (profile as any).email = authEmail;
      } else {
        console.error(
          "[AuthService] Failed to sync profile email from auth session:",
          syncEmailError,
        );
      }
    }

    const user: AuthUser = {
      id: data.user.id,
      email: authEmail || "",
      pending_email: pendingEmailFromAuth,
      email_change_pending: !!pendingEmailFromAuth,
      name: profile?.name || data.user.user_metadata?.name || "",
      username: profile?.username || data.user.user_metadata?.username || "",
      account_type: profile?.account_type || "personal",
      bio: profile?.bio,
      location: profile?.location,
      website: profile?.website,
      avatar_url: profile?.avatar_url,
      created_at: profile?.created_at || data.user.created_at,
      phone_number: profile?.phone_number,
      tipping_enabled: profile?.tipping_enabled,
      preferences: this.mergePreferences(
        profile?.preferences || data.user.user_metadata?.preferences,
      ),
    };

    // Decode JWT to get expiry (access_token is a JWT)
    let expiresAt = 0;
    try {
      const [, payload] = accessToken.split(".");
      const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
      expiresAt = decoded.exp || 0;
    } catch {
      expiresAt = Math.floor(Date.now() / 1000) + 3600;
    }

    return {
      user,
      expires_at: expiresAt,
      is_valid: expiresAt > Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Refresh session using refresh token (v2 API)
   */
  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const pendingRefresh = this.refreshRequests.get(refreshToken);
    if (pendingRefresh) {
      return pendingRefresh;
    }

    const refreshRequest = this.performSessionRefresh(refreshToken);
    this.refreshRequests.set(refreshToken, refreshRequest);

    try {
      return await refreshRequest;
    } finally {
      if (this.refreshRequests.get(refreshToken) === refreshRequest) {
        this.refreshRequests.delete(refreshToken);
      }
    }
  }

  private async performSessionRefresh(
    refreshToken: string,
  ): Promise<AuthSession> {
    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      console.warn("[AuthService] Session refresh rejected", {
        code: error?.code,
        status: error?.status,
        message: error?.message,
      });
      throw Object.assign(
        new Error("Your session has expired. Please sign in again."),
        {
          code: "INVALID_REFRESH_TOKEN",
          statusCode: 401,
        },
      );
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at || 0,
      expires_in: data.session.expires_in || 3600,
      token_type: data.session.token_type || "bearer",
    };
  }

  /**
   * Update user email in app profile table only (public.users)
   * Note: this intentionally does NOT update Supabase Auth email.
   */
  async updateEmail(userId: string, newEmail: string): Promise<void> {
    const normalizedEmail = newEmail.trim().toLowerCase();

    // 1) Fetch current profile email and short-circuit no-op requests.
    const { data: currentUser, error: currentUserError } = await this.supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();
    if (currentUserError) {
      throw Object.assign(
        new Error("Could not read current profile details for email update"),
        {
          code: "EMAIL_UPDATE_PRECHECK_FAILED",
          statusCode: 400,
          details: currentUserError.message,
        },
      );
    }

    const currentEmail = (currentUser?.email || "").toLowerCase();
    if (currentEmail === normalizedEmail) {
      return;
    }

    // 2) Check for conflicts in users table.
    const { data: existingByEmail, error: existingByEmailError } =
      await this.supabase
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .neq("id", userId)
        .limit(1);
    if (existingByEmailError) {
      throw Object.assign(
        new Error("Could not validate email availability before update"),
        {
          code: "EMAIL_UPDATE_PRECHECK_FAILED",
          statusCode: 500,
          details: existingByEmailError.message,
        },
      );
    }

    if (existingByEmail && existingByEmail.length > 0) {
      throw Object.assign(
        new Error("This email is already in use by another account."),
        {
          code: "EMAIL_EXISTS",
          statusCode: 409,
        },
      );
    }

    // 3) Update users table only.
    const { error: dbError } = await this.supabase
      .from("users")
      .update({ email: normalizedEmail })
      .eq("id", userId);

    if (dbError) {
      console.error("[AuthService] Users table email update failed:", dbError);
      const isConflict = (dbError as any)?.code === "23505";
      throw Object.assign(
        new Error(
          isConflict
            ? "This email is already in use by another account."
            : "Unable to update email in profile table.",
        ),
        {
          code: isConflict ? "EMAIL_EXISTS" : "EMAIL_UPDATE_FAILED",
          statusCode: isConflict ? 409 : 500,
          details: dbError.message,
        },
      );
    }
  }

  /**
   * Update auth email using end-user bearer token (self-service flow).
   * This avoids admin-level update constraints and mirrors native Supabase UX.
   */
  async updateEmailWithAccessToken(
    accessToken: string,
    newEmail: string,
  ): Promise<{
    auth_email: string;
    pending_email: string | null;
    status: "updated" | "pending_confirmation";
  }> {
    const normalizedEmail = newEmail.trim().toLowerCase();

    if (!accessToken) {
      throw Object.assign(
        new Error("Your session has expired. Please sign in again."),
        {
          code: "AUTH_SESSION_MISSING",
          statusCode: 401,
        },
      );
    }

    const frontendUrl =
      process.env.FRONTEND_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://hilaq.com";
    const redirectUrl = `${frontendUrl.replace(/\/$/, "")}/settings/account?email_change=confirmed`;
    const requestUrl = `${SUPABASE_URL}/auth/v1/user?redirect_to=${encodeURIComponent(
      redirectUrl,
    )}`;

    const response = await fetch(requestUrl, {
      method: "PUT",
      headers: {
        apikey: SUPABASE_ANON_KEY as string,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: normalizedEmail }),
    });

    const payload: any = await response.json().catch(() => ({}) as any);
    if (!response.ok) {
      throw Object.assign(
        new Error(
          payload?.msg ||
            payload?.message ||
            payload?.error_description ||
            "Unable to update email at authentication level.",
        ),
        {
          code: "EMAIL_UPDATE_FAILED",
          statusCode: response.status || 400,
          details: payload?.error || undefined,
        },
      );
    }

    const user = payload?.user || payload;
    const authEmail = String(user?.email || "").toLowerCase();
    const candidatePending =
      String(user?.new_email || user?.email_change || "").toLowerCase() || null;
    const pendingEmail =
      candidatePending ||
      (authEmail !== normalizedEmail ? normalizedEmail : null);

    return {
      auth_email: authEmail || normalizedEmail,
      pending_email: pendingEmail,
      status: pendingEmail ? "pending_confirmation" : "updated",
    };
  }

  /**
   * Update user password directly (v2 Admin API)
   */
  async updatePasswordDirect(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    // 1. Get user email
    const { data: userData, error: userError } =
      await this.supabase.auth.admin.getUserById(userId);
    if (userError || !userData.user?.email) {
      throw Object.assign(new Error("User not found"), {
        code: "USER_NOT_FOUND",
        statusCode: 404,
      });
    }

    const email = userData.user.email;

    // 2. Verify old password by attempting to sign in
    const { error: verifyError } = await this.supabase.auth.signInWithPassword({
      email,
      password: oldPassword,
    });

    if (verifyError) {
      throw Object.assign(
        new Error("The old password you entered is incorrect."),
        {
          code: "INVALID_OLD_PASSWORD",
          statusCode: 401,
        },
      );
    }

    // 3. Update with new password
    const { error } = await this.supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      console.error("[AuthService] Password update error:", error);
      throw Object.assign(new Error(error.message), {
        code: "PASSWORD_UPDATE_FAILED",
        statusCode: 400,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  /**
   * Generate Google OAuth URL (v2 API)
   * Redirects to frontend callback where tokens are extracted from fragment
   */
  async getGoogleAuthUrl(
    redirect: string,
    accountType: string,
  ): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";

    // Redirect to frontend callback - tokens will be in the URL fragment
    // Frontend extracts them and POSTs to /api/auth/google/process
    const callbackParams = new URLSearchParams({
      next: redirect,
      account_type: accountType,
    });
    const redirectUri = `${frontendUrl}/auth/callback?${callbackParams}`;

    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectUri,
        skipBrowserRedirect: true, // We'll handle redirect ourselves
      },
    });

    if (error || !data.url) {
      throw Object.assign(
        new Error("We couldn't connect to Google right now. Please try again."),
        {
          code: "OAUTH_ERROR",
          statusCode: 500,
        },
      );
    }

    return data.url;
  }

  /**
   * Handle Google OAuth tokens from implicit flow
   * Tokens come directly from the URL fragment, no code exchange needed
   */
  async handleGoogleTokens(
    accessToken: string,
    refreshToken?: string,
    next?: string,
    accountType?: string,
  ): Promise<{
    user: AuthUser;
    session: AuthSession;
    isNewUser: boolean;
    redirectPath: string;
  }> {
    const redirectPath = next || "/dashboard";
    const oauthAccountType =
      (accountType as "personal" | "organization") || "personal";

    // Verify the access token and get user info
    const { data: userData, error: userError } =
      await this.supabase.auth.getUser(accessToken);

    if (userError || !userData.user) {
      console.error(
        "[AuthService] OAuth token verification failed:",
        userError,
      );
      throw Object.assign(
        new Error(
          "We couldn't complete your Google sign-in. Please try again.",
        ),
        {
          code: "OAUTH_FAILED",
          statusCode: 401,
        },
      );
    }

    const supabaseUser = userData.user;

    // Check if user already exists in our users table
    const { data: existingProfile, error: profileError } = await this.supabase
      .from("users")
      .select(
        "id, name, username, account_type, preferences, bio, location, website, avatar_url, created_at, tipping_enabled, phone_number",
      )
      .eq("id", supabaseUser.id)
      .maybeSingle();

    if (profileError) {
      console.error(
        "[AuthService] Existing profile lookup failed:",
        profileError,
      );
    }

    let isNewUser = false;
    let profile = existingProfile;

    if (!existingProfile) {
      // New user - create profile with auto-generated username
      isNewUser = true;
      const name =
        supabaseUser.user_metadata?.full_name ||
        supabaseUser.user_metadata?.name ||
        supabaseUser.email?.split("@")[0] ||
        "User";
      const username = await this.generateUsername(name);

      // Check if another user already has this email
      const { data: emailConflict } = await this.supabase
        .from("users")
        .select("id")
        .eq("email", supabaseUser.email?.toLowerCase())
        .maybeSingle();

      if (emailConflict && emailConflict.id !== supabaseUser.id) {
        throw Object.assign(
          new Error(
            "An account with this email already exists. Please sign in using your original method (e.g., password or another social provider).",
          ),
          {
            code: "EMAIL_EXISTS_ANOTHER_METHOD",
            statusCode: 400,
          },
        );
      }

      const { error: insertError } = await this.supabase.from("users").insert([
        {
          id: supabaseUser.id,
          email: supabaseUser.email?.toLowerCase(),
          name,
          username,
          account_type: oauthAccountType,
          avatar_url:
            supabaseUser.user_metadata?.avatar_url ||
            supabaseUser.user_metadata?.picture ||
            null,
        },
      ]);

      if (insertError) {
        console.error("[AuthService] OAuth user insert failed:", insertError);

        throw Object.assign(
          new Error(
            "We couldn't complete your account setup. Please try again or contact support.",
          ),
          {
            code: "DB_ERROR",
            statusCode: 500,
          },
        );
      }

      profile = {
        id: supabaseUser.id,
        name,
        username,
        phone_number: null,
        account_type: oauthAccountType,
        preferences: { onboarding_role: oauthAccountType },
        bio: null,
        location: null,
        website: null,
        avatar_url:
          supabaseUser.user_metadata?.avatar_url ||
          supabaseUser.user_metadata?.picture ||
          null,
        created_at: supabaseUser.created_at,
        tipping_enabled: true,
      };
    }

    const user: AuthUser = {
      id: supabaseUser.id,
      email: supabaseUser.email || "",
      name: profile?.name || "",
      username: profile?.username || "",
      account_type: profile?.account_type || "personal",
      bio: profile?.bio,
      location: profile?.location,
      website: profile?.website,
      avatar_url: profile?.avatar_url,
      created_at: profile?.created_at || supabaseUser.created_at,
      phone_number: profile?.phone_number,
      tipping_enabled: profile?.tipping_enabled,
      preferences: this.mergePreferences(profile?.preferences),
    };

    // Decode JWT to get expiry info
    let expiresAt = 0;
    let expiresIn = 3600;
    try {
      const [, payload] = accessToken.split(".");
      const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
      expiresAt = decoded.exp || 0;
      expiresIn = expiresAt - Math.floor(Date.now() / 1000);
    } catch {
      expiresAt = Math.floor(Date.now() / 1000) + 3600;
      expiresIn = 3600;
    }

    const session: AuthSession = {
      access_token: accessToken,
      refresh_token: refreshToken || "",
      expires_at: expiresAt,
      expires_in: expiresIn > 0 ? expiresIn : 3600,
      token_type: "bearer",
    };

    return { user, session, isNewUser, redirectPath };
  }

  // ---------------------------------------------------------------------------
  // Cookie Helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode session data to Supabase SSR-compatible cookie format
   */
  encodeSessionCookie(session: AuthSession, user?: AuthUser): string {
    const fullPayload = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      token_type: session.token_type,
    };
    const fullEncoded = Buffer.from(JSON.stringify(fullPayload)).toString(
      "base64",
    );

    // Prefer full payload when it fits.
    if (fullEncoded.length <= this.MAX_COOKIE_NAME_VALUE_SIZE - 64) {
      return fullEncoded;
    }

    // Fallback: drop refresh token to stay under browser cookie limits.
    const compactPayload = {
      access_token: session.access_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      token_type: session.token_type,
    };
    const compactEncoded = Buffer.from(JSON.stringify(compactPayload)).toString(
      "base64",
    );

    if (compactEncoded.length <= this.MAX_COOKIE_NAME_VALUE_SIZE - 64) {
      return compactEncoded;
    }

    // Last fallback: raw access token prefixed marker (smallest overhead).
    return `${this.COOKIE_TOKEN_PREFIX}${session.access_token}`;
  }

  /**
   * Decode auth cookie and extract access token across supported formats.
   */
  extractAccessTokenFromCookieValue(cookieValue: string): string | null {
    if (!cookieValue) return null;

    if (cookieValue.startsWith(this.COOKIE_TOKEN_PREFIX)) {
      return cookieValue.slice(this.COOKIE_TOKEN_PREFIX.length) || null;
    }

    // Legacy compatibility: some older flows stored the raw JWT directly in a `token` cookie.
    if (cookieValue.split(".").length === 3) {
      return cookieValue;
    }

    try {
      const parsed = JSON.parse(Buffer.from(cookieValue, "base64").toString());
      if (parsed?.access_token) return parsed.access_token as string;
    } catch {
      // Ignore parse errors and fall through.
    }

    return null;
  }

  /**
   * Decode auth cookie and extract refresh token.
   * Returns null for the raw-token prefix format (no refresh token encoded).
   */
  extractRefreshTokenFromCookieValue(cookieValue: string): string | null {
    if (!cookieValue) return null;
    if (cookieValue.startsWith(this.COOKIE_TOKEN_PREFIX)) return null;

    try {
      const parsed = JSON.parse(Buffer.from(cookieValue, "base64").toString());
      return (parsed?.refresh_token as string) || null;
    } catch {
      return null;
    }
  }

  private parseCookieHeader(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};

    cookieHeader.split(";").forEach((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) return;
      const name = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      cookies[name] = decodeURIComponent(value);
    });

    return cookies;
  }

  private getAuthCookieName(): string {
    return `sb-${this.projectRef}-auth-token`;
  }

  private getRefreshCookieName(): string {
    return `sb-${this.projectRef}-refresh-token`;
  }

  /**
   * Parse the auth cookie value from a raw cookie header string.
   */
  extractAuthCookieValue(cookieHeader: string): string | null {
    const cookies = this.parseCookieHeader(cookieHeader);
    const exactCookieName = this.getAuthCookieName();
    if (cookies[exactCookieName]) {
      return cookies[exactCookieName];
    }

    if (cookies.token) {
      return cookies.token;
    }

    const authCookieEntries = Object.entries(cookies).filter(([name]) =>
      /^sb-[^.]+-auth-token(?:\.\d+)?$/.test(name),
    );

    if (authCookieEntries.length === 0) {
      return null;
    }

    const baseCookie = authCookieEntries.find(
      ([name]) => !name.endsWith(".0") && !name.match(/\.\d+$/),
    );
    if (baseCookie) {
      return baseCookie[1];
    }

    const chunkedCookie = authCookieEntries
      .map(([name, value]) => {
        const chunkIndex = Number(name.split(".").pop());
        return Number.isNaN(chunkIndex) ? null : { chunkIndex, value };
      })
      .filter((entry): entry is { chunkIndex: number; value: string } => !!entry)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(({ value }) => value)
      .join("");

    return chunkedCookie || null;
  }

  extractRefreshTokenCookieValue(cookieHeader: string): string | null {
    const cookies = this.parseCookieHeader(cookieHeader);
    const refreshCookieName = this.getRefreshCookieName();
    const refreshCookieValue = cookies[refreshCookieName];

    if (refreshCookieValue) {
      return refreshCookieValue;
    }

    const authCookieValue = this.extractAuthCookieValue(cookieHeader);
    if (!authCookieValue) {
      return null;
    }

    return this.extractRefreshTokenFromCookieValue(authCookieValue);
  }

  /**
   * Helper to derive cookie domain from frontend url
   */
  private getCookieDomain(): string | undefined {
    const explicitCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim();
    if (explicitCookieDomain) {
      const normalizedDomain = explicitCookieDomain.replace(/^\./, "");
      if (
        normalizedDomain === "localhost" ||
        normalizedDomain === "127.0.0.1"
      ) {
        console.warn(
          `[AuthService] Ignoring AUTH_COOKIE_DOMAIN=${explicitCookieDomain} because browsers do not reliably support shared localhost cookie domains`,
        );
        return undefined;
      }

      return `.${normalizedDomain}`;
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    let domain: string | undefined = undefined;

    try {
      const url = new URL(frontendUrl);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        domain = "." + url.hostname.replace(/^www\./, "");
      } else if (url.hostname === "localhost") {
        domain = undefined; // Subdomains on localhost are not supported natively by cookies with .localhost domains
      }
    } catch (e) {
      domain = undefined;
    }

    return domain;
  }

  /**
   * Create Set-Cookie headers for Supabase SSR compatibility
   */
  createAuthCookies(session: AuthSession, user?: AuthUser): Cookie[] {
    const cookieName = this.getAuthCookieName();
    const refreshCookieName = this.getRefreshCookieName();
    const cookieValue = this.encodeSessionCookie(session, user);
    const totalNameValueSize = cookieName.length + cookieValue.length;
    if (totalNameValueSize > this.MAX_COOKIE_NAME_VALUE_SIZE) {
      console.warn(
        `[AuthService] Skipping auth cookie: size ${totalNameValueSize} exceeds browser limit`,
      );
      return [];
    }
    // `session.expires_in` is in seconds (Supabase), while Express `res.cookie`
    // expects `maxAge` in milliseconds.
    const maxAgeSeconds = session.expires_in || 60 * 60 * 24 * 7; // 7 days default
    const maxAge = maxAgeSeconds * 1000;
    const domain = this.getCookieDomain();
    const isProduction = process.env.NODE_ENV === "production";
    const sameSite = isProduction ? ("none" as const) : ("lax" as const);
    const cookies: Cookie[] = [
      {
        name: cookieName,
        value: cookieValue,
        options: {
          path: "/",
          httpOnly: true,
          secure: isProduction,
          // Must be 'none' for cross-origin/subdomain requests.
          sameSite,
          maxAge,
          domain,
        },
      },
    ];

    if (session.refresh_token) {
      cookies.push({
        name: refreshCookieName,
        value: session.refresh_token,
        options: {
          path: "/",
          httpOnly: true,
          secure: isProduction,
          sameSite,
          maxAge: this.REFRESH_COOKIE_MAX_AGE_MS,
          domain,
        },
      });
    }

    cookies.push(
      {
        name: "token",
        value: "",
        options: {
          path: "/",
          httpOnly: false,
          secure: isProduction,
          sameSite,
          maxAge: 0,
          domain,
        },
      },
    );

    return cookies;
  }

  /**
   * Create cookies to clear auth session
   */
  createClearCookies(): Cookie[] {
    const cookieName = this.getAuthCookieName();
    const refreshCookieName = this.getRefreshCookieName();
    const domain = this.getCookieDomain();
    const isProduction = process.env.NODE_ENV === "production";
    const sameSite = isProduction ? ("none" as const) : ("lax" as const);

    return [
      {
        name: cookieName,
        value: "",
        options: {
          path: "/",
          httpOnly: true,
          secure: isProduction,
          sameSite,
          maxAge: 0,
          domain,
        },
      },
      {
        name: refreshCookieName,
        value: "",
        options: {
          path: "/",
          httpOnly: true,
          secure: isProduction,
          sameSite,
          maxAge: 0,
          domain,
        },
      },
      {
        name: "token",
        value: "",
        options: {
          path: "/",
          httpOnly: false,
          secure: isProduction,
          sameSite,
          maxAge: 0,
          domain,
        },
      },
    ];
  }

  /**
   * Get the project reference for cookie naming
   */
  getProjectRef(): string {
    return this.projectRef;
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

export const authService = new AuthService();
export default AuthService;
