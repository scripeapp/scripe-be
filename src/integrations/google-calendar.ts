/**
 * Google Calendar over its REST API, for booking sync (Settings ›
 * Integrations). A person "connects" by linking their Google account through
 * Better Auth with the calendar scopes below; Better Auth stores the tokens in
 * auth.account and refreshes the access token on demand. This module only
 * reads that account and calls Google.
 */
import { sql } from "kysely";
import { getAuth } from "../auth/server.js";
import { getDatabase } from "../db/database.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const PRIMARY_CALENDAR = "primary";

export interface GoogleCalendarAccount {
  /** Better Auth's account row id. */
  readonly accountId: string;
  /** The Google address it is linked to (from the ID token), when known. */
  readonly email: string | null;
}

interface AccountRow {
  readonly id: string;
  readonly scope: string | null;
  readonly idToken: string | null;
  readonly refreshToken: string | null;
}

/** Better Auth writes granted scopes comma-separated; Google itself uses spaces. */
function scopeList(scope: string | null): string[] {
  return (scope ?? "").split(/[\s,]+/).filter(Boolean);
}

function emailFromIdToken(idToken: string | null): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

async function findGoogleAccountRow(userId: string): Promise<AccountRow | undefined> {
  const result = await sql<AccountRow>`
    select "id", "scope", "idToken", "refreshToken" from auth.account
    where "userId" = ${userId}::uuid and "providerId" = 'google'
    order by "updatedAt" desc limit 1
  `.execute(getDatabase());
  return result.rows[0];
}

/** The person's Google account when it can still reach their calendar (calendar scope granted, refresh token held), else null. */
export async function findGoogleCalendarAccount(userId: string): Promise<GoogleCalendarAccount | null> {
  const row = await findGoogleAccountRow(userId);
  if (!row?.refreshToken) return null;
  const granted = scopeList(row.scope);
  if (!GOOGLE_CALENDAR_SCOPES.every((scope) => granted.includes(scope))) return null;
  return { accountId: row.id, email: emailFromIdToken(row.idToken) };
}

async function accessToken(userId: string, account: GoogleCalendarAccount): Promise<string> {
  const tokens = await getAuth().api.getAccessToken({ body: { accountId: account.accountId, userId } });
  if (!tokens.accessToken) throw new Error("Google did not return an access token");
  return tokens.accessToken;
}

class GoogleCalendarError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function callGoogle<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new GoogleCalendarError(response.status, `Google Calendar ${method} ${path} failed (${response.status}): ${detail?.error?.message ?? response.statusText}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export interface CalendarEventInput {
  /** Stable per booked service; Google uses it to make the Meet request idempotent. */
  readonly requestId: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly attendeeEmail: string | null;
  readonly withMeet: boolean;
}

interface GoogleEvent {
  readonly id: string;
  readonly hangoutLink?: string;
}

/** Creates the event and, when asked, a Google Meet link; Google emails the invite (with the link) to the customer. */
export async function createCalendarEvent(userId: string, account: GoogleCalendarAccount, input: CalendarEventInput): Promise<{ eventId: string; meetUrl: string | null }> {
  const token = await accessToken(userId, account);
  const query = `conferenceDataVersion=1&sendUpdates=${input.attendeeEmail ? "all" : "none"}`;
  const event = await callGoogle<GoogleEvent>(token, "POST", `/calendars/${PRIMARY_CALENDAR}/events?${query}`, {
    summary: input.summary,
    description: input.description,
    location: input.location ?? undefined,
    start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone },
    attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
    conferenceData: input.withMeet
      ? { createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } }
      : undefined,
  });
  return { eventId: event.id, meetUrl: event.hangoutLink ?? null };
}

/** Moves an event after a reschedule, telling the customer. */
export async function moveCalendarEvent(
  userId: string,
  account: GoogleCalendarAccount,
  eventId: string,
  times: { startsAt: Date; endsAt: Date; timezone: string },
): Promise<void> {
  const token = await accessToken(userId, account);
  await callGoogle(token, "PATCH", `/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    start: { dateTime: times.startsAt.toISOString(), timeZone: times.timezone },
    end: { dateTime: times.endsAt.toISOString(), timeZone: times.timezone },
  });
}

/** Deletes an event, telling the customer. An event that is already gone counts as deleted. */
export async function deleteCalendarEvent(userId: string, account: GoogleCalendarAccount, eventId: string): Promise<void> {
  const token = await accessToken(userId, account);
  try {
    await callGoogle(token, "DELETE", `/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
  } catch (error) {
    if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return;
    throw error;
  }
}

/** The person's busy blocks in their primary calendar between two instants. */
export async function busyIntervals(userId: string, account: GoogleCalendarAccount, from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
  const token = await accessToken(userId, account);
  const result = await callGoogle<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(token, "POST", "/freeBusy", {
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    items: [{ id: PRIMARY_CALENDAR }],
  });
  return (result.calendars?.[PRIMARY_CALENDAR]?.busy ?? []).map((block) => ({ start: new Date(block.start), end: new Date(block.end) }));
}

/**
 * Disconnects Calendar: revokes Google's grant and forgets the tokens and
 * calendar scopes. The account link itself stays, so signing in with Google
 * keeps working.
 */
export async function disconnectGoogleCalendar(userId: string): Promise<void> {
  const row = await findGoogleAccountRow(userId);
  if (!row) return;
  if (row.refreshToken) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refreshToken)}`, { method: "POST" }).catch((error: unknown) => {
      console.warn("[google-calendar] token revoke failed:", error);
    });
  }
  const remaining = scopeList(row.scope).filter((scope) => !(GOOGLE_CALENDAR_SCOPES as readonly string[]).includes(scope));
  await sql`
    update auth.account
    set "accessToken" = null, "refreshToken" = null, "accessTokenExpiresAt" = null, "refreshTokenExpiresAt" = null,
        "scope" = ${remaining.length > 0 ? remaining.join(",") : null}, "updatedAt" = now()
    where "id" = ${row.id}::uuid
  `.execute(getDatabase());
}
