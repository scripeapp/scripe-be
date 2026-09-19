import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { getDatabase } from "../db/database.js";
import { loadEnvironment } from "../shared/environment.js";
import { emailSender } from "../shared/email.js";

const EMAIL_VERIFICATION_CODE_LENGTH = 6;
const EMAIL_VERIFICATION_CODE_TTL_SECONDS = 600;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
const EMAIL_VERIFICATION_RATE_LIMIT = { window: 300, max: 10 } as const;

let authInstance: ReturnType<typeof createAuth> | undefined;

function createAuth() {
  const environment = loadEnvironment();
  const baseUrl = new URL(environment.BETTER_AUTH_URL);

  const socialProviders: { google?: { clientId: string; clientSecret: string } } =
    {};
  if (environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
    };
  }

  return betterAuth({
    appName: "Surge",
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    database: {
      db: getDatabase(),
      type: "postgres",
      schemaName: "auth",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await emailSender.sendPasswordResetEmail(user.email, url);
      },
    },
    emailVerification: {
      // Verify by an emailed code, not a link; the OTP plugin owns the email
      // and auto-signs the user in once the code is accepted.
      autoSignInAfterVerification: true,
    },
    socialProviders,
    plugins: [
      passkey(),
      emailOTP({
        otpLength: EMAIL_VERIFICATION_CODE_LENGTH,
        expiresIn: EMAIL_VERIFICATION_CODE_TTL_SECONDS,
        allowedAttempts: EMAIL_VERIFICATION_MAX_ATTEMPTS,
        storeOTP: "hashed",
        overrideDefaultEmailVerification: true,
        rateLimit: EMAIL_VERIFICATION_RATE_LIMIT,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "email-verification") return;
          await emailSender.sendVerificationCode(email, otp);
        },
      }),
    ],
    trustedOrigins: [
      baseUrl.origin,
      environment.AUTH_TRUSTED_ORIGINS,
    ].flat(),
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
      crossSubDomainCookies: {
        enabled: true,
        domain: environment.AUTH_COOKIE_DOMAIN,
      },
      defaultCookieAttributes: {
        secure: environment.NODE_ENV === "production",
        sameSite: "lax",
        httpOnly: true,
      },
    },
    rateLimit: {
      window: 60,
      max: 120,
      customs: {
        "/sign-up/email": { window: 300, max: 5 },
        "/sign-in/email": { window: 300, max: 10 },
        "/request-password-reset": { window: 300, max: 5 },
        "/reset-password": { window: 300, max: 5 },
        "/send-verification-email": { window: 300, max: 5 },
        "/passkey/register": { window: 300, max: 10 },
        "/passkey/authenticate": { window: 300, max: 10 },
      },
    },
  });
}

export function getAuth() {
  if (!authInstance) {
    authInstance = createAuth();
  }
  return authInstance;
}
