import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function generateAuthUrl(state: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent", // Force refresh_token on every connect
  });
}

export async function exchangeCodeForTokens(code: string) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

export async function getUserEmail(accessToken: string): Promise<string | null> {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data.email ?? null;
}

export async function refreshAccessToken(refreshToken: string) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials;
}

export async function createCalendarEvent(
  refreshToken: string,
  event: {
    summary: string;
    description?: string;
    startTime: string;
    endTime: string;
    attendeeEmails?: string[];
    withMeet?: boolean;
    timezone?: string;
  }
) {
  const oauth2Client = getOAuthClient();
  
  // Set credentials with refresh token - the client will auto-refresh
  oauth2Client.setCredentials({ 
    refresh_token: refreshToken,
    expiry_date: Date.now() + 60000, // Set expiry slightly in future to trigger refresh
  });

  // Force token refresh before making the API call
  try {
    await oauth2Client.refreshAccessToken();
  } catch (refreshError) {
    console.error("[GoogleCalendar] Token refresh failed:", refreshError);
    throw new Error("Failed to refresh Google Calendar access token");
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const requestBody: any = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.startTime, timeZone: event.timezone ?? "UTC" },
    end: { dateTime: event.endTime, timeZone: event.timezone ?? "UTC" },
    attendees: event.attendeeEmails?.map((email) => ({ email })) ?? [],
  };

  if (event.withMeet) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `hilaq-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody,
    conferenceDataVersion: event.withMeet ? 1 : 0,
    sendUpdates: "all",
  });

  return response.data;
}
