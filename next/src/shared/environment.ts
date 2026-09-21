import { z } from "zod";

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z
    .string()
    .min(1)
    .optional()
    .refine((url) => !url || !/^postgres(ql)?:\/\/postgres(?=[:@])/.test(url), {
      message: "Migrations must never connect as the postgres superuser.",
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL_MODE: z.enum(["disable", "require"]).default("disable"),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ALLOW_DATABASE_RESET: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  AUTH_COOKIE_DOMAIN: z.string().default("localhost"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  AUTH_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  PLUNK_API_KEY: z.string().optional(),
  PLUNK_FROM_EMAIL: z.string().email().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.PLUNK_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PLUNK_API_KEY"],
      message: "PLUNK_API_KEY is required in production.",
    });
  }
  const r2Fields = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;
  const r2Configured = r2Fields.filter((field) => environment[field]).length;
  if (r2Configured > 0 && r2Configured < r2Fields.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["R2_ACCOUNT_ID"],
      message: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME must be set together or not at all.",
    });
  }
  if (environment.NODE_ENV === "production" && r2Configured === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["R2_ACCOUNT_ID"],
      message: "R2 object storage credentials are required in production.",
    });
  }
});

export type Environment = z.infer<typeof EnvironmentSchema>;

/** An optional field left blank (e.g. `PLUNK_FROM_EMAIL=` in .env.example) must read as "not set", not "set to an invalid empty string". */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== "") normalized[key] = value;
  }
  return normalized;
}

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const parsed = EnvironmentSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}
