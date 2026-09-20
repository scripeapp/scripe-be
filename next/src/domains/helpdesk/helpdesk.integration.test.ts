import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string; email: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies, email };
}

describe("helpdesk domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/support/tickets")).status).toBe(401);
  });

  it("creates a ticket, lists it, and replying moves it from open to in_progress", async () => {
    const user = await authenticate("Ticket Submitter");

    const created = await request(server.baseUrl, "/api/support/tickets", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ subject: "Cannot log in", description: "OTP email never arrives", category: "technical" }),
    });
    expect(created.status).toBe(201);
    const ticket = (created.body as { data: { ticket: { id: string; status: string; submitterEmail: string; priority: string } } }).data.ticket;
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("medium");
    expect(ticket.submitterEmail).toBe(user.email);

    const listed = await request(server.baseUrl, "/api/support/tickets", { cookie: user.cookies });
    expect(listed.status).toBe(200);
    expect((listed.body as { data: { tickets: { id: string }[] } }).data.tickets.map((t) => t.id)).toEqual([ticket.id]);

    const replied = await request(server.baseUrl, `/api/support/tickets/${ticket.id}/replies`, {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ body: "Still no email after 10 minutes" }),
    });
    expect(replied.status).toBe(201);
    expect((replied.body as { data: { reply: { isInternal: boolean } } }).data.reply.isInternal).toBe(false);

    const fetched = await request(server.baseUrl, `/api/support/tickets/${ticket.id}`, { cookie: user.cookies });
    expect(fetched.status).toBe(200);
    const withReplies = (fetched.body as { data: { ticket: { status: string; replies: { body: string }[] } } }).data.ticket;
    expect(withReplies.status).toBe("in_progress");
    expect(withReplies.replies).toHaveLength(1);
  });

  it("accepts a businessId the user belongs to and rejects one they don't", async () => {
    const owner = await authenticate("Business Owner Ticket");
    const businessResponse = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Helpdesk Test Co" }),
    });
    const businessId = (businessResponse.body as { data: { business: { id: string } } }).data.business.id;

    const withOwnBusiness = await request(server.baseUrl, "/api/support/tickets", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ subject: "Billing question", description: "Why was I charged twice", category: "billing", businessId }),
    });
    expect(withOwnBusiness.status).toBe(201);

    const outsider = await authenticate("Non Member Ticket");
    const withForeignBusiness = await request(server.baseUrl, "/api/support/tickets", {
      method: "POST",
      cookie: outsider.cookies,
      body: JSON.stringify({ subject: "Billing question", description: "Not my business", category: "billing", businessId }),
    });
    expect(withForeignBusiness.status).toBe(400);
  });

  it("isolates tickets between users", async () => {
    const owner = await authenticate("Isolated Ticket Owner");
    const outsider = await authenticate("Isolated Ticket Outsider");

    const created = await request(server.baseUrl, "/api/support/tickets", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ subject: "Private issue", description: "Should not be visible to others", category: "account" }),
    });
    const ticket = (created.body as { data: { ticket: { id: string } } }).data.ticket;

    const outsiderList = await request(server.baseUrl, "/api/support/tickets", { cookie: outsider.cookies });
    expect((outsiderList.body as { data: { tickets: unknown[] } }).data.tickets).toHaveLength(0);

    const outsiderGet = await request(server.baseUrl, `/api/support/tickets/${ticket.id}`, { cookie: outsider.cookies });
    expect(outsiderGet.status).toBe(404);

    const outsiderReply = await request(server.baseUrl, `/api/support/tickets/${ticket.id}/replies`, {
      method: "POST",
      cookie: outsider.cookies,
      body: JSON.stringify({ body: "Trying to butt in" }),
    });
    expect(outsiderReply.status).toBe(404);
  });
});
