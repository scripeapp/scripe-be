import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import * as notificationsRepository from "./notifications.repository.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  if (!userId) throw new Error(`Sign-up response missing user: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies, userId };
}

/** Simulates a future domain calling createNotification server-side — no route exposes this in this slice. */
async function createNotificationDirectly(userId: string, requestId: string, overrides: Partial<Parameters<typeof notificationsRepository.createNotification>[1]> = {}) {
  return withDatabaseContext(getDatabase(), withIdentity(requestId, userId, null), (context) =>
    notificationsRepository.createNotification(context, {
      userId,
      type: "test.event",
      title: "Something happened",
      body: "Details about the event",
      ...overrides,
    }),
  );
}

describe("notifications domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/me/notifications")).status).toBe(401);
    expect((await request(server.baseUrl, "/api/me/notification-preferences")).status).toBe(401);
  });

  it("lists a system-created notification, tracks unread count, and supports read/archive", async () => {
    const user = await authenticate("Notified User");
    const created = await createNotificationDirectly(user.userId, randomUUID());

    const listed = await request(server.baseUrl, "/api/me/notifications", { cookie: user.cookies });
    expect(listed.status).toBe(200);
    const notifications = (listed.body as { data: { notifications: { id: string; readAt: string | null }[] } }).data.notifications;
    expect(notifications.map((n) => n.id)).toContain(created.id);
    expect(notifications.find((n) => n.id === created.id)?.readAt).toBeNull();

    const unreadCount = await request(server.baseUrl, "/api/me/notifications/unread-count", { cookie: user.cookies });
    expect((unreadCount.body as { data: { unreadCount: number } }).data.unreadCount).toBeGreaterThanOrEqual(1);

    const markedRead = await request(server.baseUrl, `/api/me/notifications/${created.id}`, {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ read: true }),
    });
    expect(markedRead.status).toBe(200);
    expect((markedRead.body as { data: { notification: { readAt: string | null } } }).data.notification.readAt).not.toBeNull();

    const unreadOnly = await request(server.baseUrl, "/api/me/notifications?unreadOnly=true", { cookie: user.cookies });
    expect((unreadOnly.body as { data: { notifications: { id: string }[] } }).data.notifications.map((n) => n.id)).not.toContain(created.id);

    const archived = await request(server.baseUrl, `/api/me/notifications/${created.id}`, {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);

    const defaultList = await request(server.baseUrl, "/api/me/notifications", { cookie: user.cookies });
    expect((defaultList.body as { data: { notifications: { id: string }[] } }).data.notifications.map((n) => n.id)).not.toContain(created.id);

    const withArchived = await request(server.baseUrl, "/api/me/notifications?includeArchived=true", { cookie: user.cookies });
    expect((withArchived.body as { data: { notifications: { id: string }[] } }).data.notifications.map((n) => n.id)).toContain(created.id);
  });

  it("rejects an empty update body", async () => {
    const user = await authenticate("Empty Update User");
    const created = await createNotificationDirectly(user.userId, randomUUID());
    const response = await request(server.baseUrl, `/api/me/notifications/${created.id}`, {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("isolates notifications between users", async () => {
    const recipient = await authenticate("Isolated Recipient");
    const outsider = await authenticate("Isolated Outsider");
    const created = await createNotificationDirectly(recipient.userId, randomUUID());

    const outsiderList = await request(server.baseUrl, "/api/me/notifications", { cookie: outsider.cookies });
    expect((outsiderList.body as { data: { notifications: { id: string }[] } }).data.notifications.map((n) => n.id)).not.toContain(created.id);

    const outsiderUpdate = await request(server.baseUrl, `/api/me/notifications/${created.id}`, {
      method: "PATCH",
      cookie: outsider.cookies,
      body: JSON.stringify({ read: true }),
    });
    expect(outsiderUpdate.status).toBe(404);
  });

  it("sets and upserts a notification preference override", async () => {
    const user = await authenticate("Preference User");

    const initial = await request(server.baseUrl, "/api/me/notification-preferences", { cookie: user.cookies });
    expect((initial.body as { data: { preferences: unknown[] } }).data.preferences).toEqual([]);

    const disabled = await request(server.baseUrl, "/api/me/notification-preferences/order.placed/email", {
      method: "PUT",
      cookie: user.cookies,
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect((disabled.body as { data: { preference: { enabled: boolean } } }).data.preference.enabled).toBe(false);

    const reenabled = await request(server.baseUrl, "/api/me/notification-preferences/order.placed/email", {
      method: "PUT",
      cookie: user.cookies,
      body: JSON.stringify({ enabled: true }),
    });
    expect(reenabled.status).toBe(200);

    const list = await request(server.baseUrl, "/api/me/notification-preferences", { cookie: user.cookies });
    const preferences = (list.body as { data: { preferences: { type: string; channel: string; enabled: boolean }[] } }).data.preferences;
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({ type: "order.placed", channel: "email", enabled: true });
  });
});
