import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

interface WorkflowResponse {
  id: string;
  name: string;
  type: string;
  status: string;
  creatorName: string;
  groups: { title: string; approvers: { userId: string | null; name: string }[]; rules: { rangeLabel: string; minAmountMinor: number | null; maxAmountMinor: number | null }[] }[];
}

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = body.user?.id ?? body.data?.user?.id;
  if (!userId) throw new Error("Sign-up response missing user");
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId };
}

async function createBusiness(cookies: string, displayName: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName }) });
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

async function listWorkflows(cookies: string, businessId: string): Promise<WorkflowResponse[]> {
  const response = await request(server.baseUrl, `/api/businesses/${businessId}/approval-workflows`, { cookie: cookies });
  expect(response.status).toBe(200);
  return (response.body as { data: { workflows: WorkflowResponse[] } }).data.workflows;
}

describe("approvals domain", () => {
  it("requires authentication on workflow and decision routes", async () => {
    const businessId = randomUUID();
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approval-workflows`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approvals`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approvals/${randomUUID()}/approve`, { method: "POST" })).status).toBe(401);
  });

  it("gives a new business switched-off Bills and Transfers workflows with its owner as approver", async () => {
    const owner = await authenticate("Starter Owner");
    const businessId = await createBusiness(owner.cookies, "Starter Co");

    const workflows = await listWorkflows(owner.cookies, businessId);
    expect(workflows.map((workflow) => [workflow.name, workflow.type, workflow.status]).sort()).toEqual([
      ["Bills", "bill_payment", "inactive"],
      ["Transfers", "withdrawal", "inactive"],
    ]);
    for (const starter of workflows) {
      expect(starter.creatorName).toBe("Starter Owner");
      expect(starter.groups).toHaveLength(1);
      expect(starter.groups[0]!.approvers).toEqual([expect.objectContaining({ userId: owner.userId, name: "Starter Owner" })]);
      expect(starter.groups[0]!.rules).toEqual([expect.objectContaining({ rangeLabel: "Everything else", minAmountMinor: null, maxAmountMinor: null })]);
    }
  });

  it("lets both starters be switched on together, and doesn't bring one back once deleted", async () => {
    const owner = await authenticate("Starter Toggle Owner");
    const businessId = await createBusiness(owner.cookies, "Starter Toggle Co");
    const starters = await listWorkflows(owner.cookies, businessId);

    for (const starter of starters) {
      const activated = await request(server.baseUrl, `/api/businesses/${businessId}/approval-workflows/${starter.id}/status`, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ status: "active" }),
      });
      expect(activated.status).toBe(200);
      expect((activated.body as { data: { workflow: WorkflowResponse } }).data.workflow.status).toBe("active");
    }

    const bills = starters.find((starter) => starter.type === "bill_payment")!;
    const deleted = await request(server.baseUrl, `/api/businesses/${businessId}/approval-workflows/${bills.id}`, { method: "DELETE", cookie: owner.cookies });
    expect([200, 204]).toContain(deleted.status);
    expect((await listWorkflows(owner.cookies, businessId)).map((workflow) => workflow.name)).toEqual(["Transfers"]);
  });
});
