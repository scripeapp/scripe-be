import { TeamService } from "../services/team.service";

type QueryResult = { data: unknown; error: unknown };

/**
 * Build a mock supabase client whose `.from(table)` returns a query builder
 * that resolves to `datasets[table]` when awaited. Mirrors how the real
 * service awaits chained builders (memberships / stores / pos_staff / users).
 */
function createRosterSupabase(datasets: Record<string, unknown>): any {
  const from = jest.fn().mockImplementation((table: string) => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      then: jest.fn().mockImplementation((resolve: (r: QueryResult) => void) =>
        resolve({ data: datasets[table] ?? [], error: null }),
      ),
    };
    return chain;
  });

  // AuditService also uses supabase; keep its calls inert.
  return { from };
}

describe("TeamService.getTeamRoster", () => {
  const businessId = "biz-1";
  const memberA = {
    id: "member-a",
    user_id: "user-a",
    business_id: businessId,
    role_id: "role-1",
    status: "active",
    joined_at: "2026-01-02",
    role: { id: "role-1", name: "Admin", is_system: true, is_owner: false },
    user: { id: "user-a", email: "a@example.com" },
  };
  const linkedStaff = {
    id: "staff-1",
    store_id: "store-1",
    user_id: "user-a",
    branch_id: "branch-1",
    name: "Alice",
    status: "active",
    created_by: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    branch: [{ id: "branch-1", name: "Main" }],
  };
  const standaloneStaff = {
    id: "staff-2",
    store_id: "store-1",
    user_id: null,
    branch_id: null,
    name: "Bob",
    status: "active",
    created_by: null,
    created_at: "2026-01-02",
    updated_at: "2026-01-02",
    branch: [],
  };

  it("merges linked till staff onto members and collects standalone staff", async () => {
    const supabase = createRosterSupabase({
      memberships: [memberA],
      stores: [{ id: "store-1" }],
      pos_staff: [linkedStaff, standaloneStaff],
      users: [{ id: "user-a", name: "Alice Member", avatar_url: "avatar.png" }],
    });

    const service = new TeamService(supabase as any);
    const roster = await service.getTeamRoster(businessId);

    expect(roster.members).toHaveLength(1);
    expect(roster.members[0].user).toEqual(
      expect.objectContaining({
        email: "a@example.com",
        name: "Alice Member",
        avatar_url: "avatar.png",
      }),
    );
    expect(roster.members[0].pos).toEqual(
      expect.objectContaining({ id: "staff-1", branch: { id: "branch-1", name: "Main" } }),
    );

    expect(roster.posOnlyStaff).toHaveLength(1);
    expect(roster.posOnlyStaff[0]).toEqual(
      expect.objectContaining({ id: "staff-2", branch: null }),
    );
  });

  it("treats till staff linked to a non-member as standalone", async () => {
    const orphanStaff = {
      ...standaloneStaff,
      id: "staff-3",
      user_id: "not-a-member",
    };
    const supabase = createRosterSupabase({
      memberships: [memberA],
      stores: [{ id: "store-1" }],
      pos_staff: [linkedStaff, orphanStaff],
      users: [{ id: "user-a", name: "Alice Member", avatar_url: null }],
    });

    const service = new TeamService(supabase as any);
    const roster = await service.getTeamRoster(businessId);

    expect(roster.members).toHaveLength(1);
    expect(roster.members[0].pos?.id).toBe("staff-1");
    expect(roster.posOnlyStaff.map((s) => s.id)).toEqual(["staff-3"]);
  });

  it("returns empty till staff when the business has no stores", async () => {
    const supabase = createRosterSupabase({
      memberships: [memberA],
      stores: [],
      pos_staff: [linkedStaff],
      users: [],
    });

    const service = new TeamService(supabase as any);
    const roster = await service.getTeamRoster(businessId);

    expect(roster.members).toHaveLength(1);
    expect(roster.posOnlyStaff).toEqual([]);
  });

  it("leaves a member without a profile and without till access intact", async () => {
    const memberB = {
      ...memberA,
      id: "member-b",
      user_id: "user-b",
      user: { id: "user-b", email: "b@example.com" },
    };
    const supabase = createRosterSupabase({
      memberships: [memberA, memberB],
      stores: [{ id: "store-1" }],
      pos_staff: [standaloneStaff],
      users: [{ id: "user-a", name: "Alice Member", avatar_url: null }],
    });

    const service = new TeamService(supabase as any);
    const roster = await service.getTeamRoster(businessId);

    const memberBRow = roster.members.find((m) => m.id === "member-b");
    expect(memberBRow?.user).toEqual({ id: "user-b", email: "b@example.com" });
    expect(memberBRow?.pos).toBeNull();
  });
});
