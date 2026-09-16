const mockRefreshSession = jest.fn();

jest.mock("../config/supabase", () => ({
  supabaseAdmin: {
    auth: {
      refreshSession: mockRefreshSession,
    },
  },
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_PROJECT_ID: "test-project",
}));

import AuthService from "../services/auth.service";

describe("AuthService refreshSession", () => {
  beforeEach(() => {
    mockRefreshSession.mockReset();
  });

  it("shares one token rotation across concurrent requests", async () => {
    let resolveRefresh: ((value: unknown) => void) | undefined;
    mockRefreshSession.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const service = new AuthService();
    const firstRefresh = service.refreshSession("shared-refresh-token");
    const secondRefresh = service.refreshSession("shared-refresh-token");

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);

    resolveRefresh?.({
      data: {
        session: {
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: 123,
          expires_in: 3600,
          token_type: "bearer",
        },
      },
      error: null,
    });

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      expect.objectContaining({ refresh_token: "new-refresh-token" }),
      expect.objectContaining({ refresh_token: "new-refresh-token" }),
    ]);
  });

  it("allows a later refresh after the in-flight request is complete", async () => {
    mockRefreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: 123,
          expires_in: 3600,
          token_type: "bearer",
        },
      },
      error: null,
    });

    const service = new AuthService();
    await service.refreshSession("shared-refresh-token");
    await service.refreshSession("shared-refresh-token");

    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
  });
});
