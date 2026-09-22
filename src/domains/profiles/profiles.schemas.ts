/**
 * Zod request and response contracts for the user profile domain belong here.
 */
import { z } from "zod";

/** Public handle: matches the free-text legacy values already in the column, while still ruling out whitespace/URL-hostile characters for new picks. */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

export const updateCurrentUserSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    firstName: z.string().trim().max(80),
    lastName: z.string().trim().max(80),
    username: z.string().trim().regex(USERNAME_RE, "Username must be 3-30 characters: letters, numbers, underscore, period, or hyphen"),
    bio: z.string().trim().max(500),
    website: z.string().trim().max(2048).refine((value) => value === "" || /^https?:\/\//i.test(value), "Website must start with http:// or https://"),
    location: z.string().trim().max(160),
    phoneNumber: z.string().trim().max(32),
    gender: z.string().trim().max(32),
    socialLinks: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const setAvatarSchema = z.object({
  uploadId: z.string().uuid(),
});

export const avatarParamsSchema = z.object({
  userId: z.string().uuid(),
});
