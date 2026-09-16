jest.mock("../config/redis", () => ({
  redis: null,
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}));

import {
  getDocument,
  getDraft,
  saveDocument,
  saveDraft,
} from "../services/ai/draft.store";
import { StoreDraft } from "../types/ai-agent.types";

describe("AI draft store", () => {
  it("keeps uploaded documents and drafts in memory when Redis is unavailable", async () => {
    await saveDocument("session-1", {
      filename: "menu.docx",
      text: "Menu content",
      truncated: false,
      uploadedAt: new Date().toISOString(),
    });

    expect(await getDocument("session-1")).toMatchObject({
      filename: "menu.docx",
      text: "Menu content",
    });

    const draft: StoreDraft = {
      draftId: "draft-1",
      businessId: "business-1",
      userId: "user-1",
      status: "pending",
      json: {},
      summary: {
        storeName: "Warm Table",
        sellsInPerson: true,
        branchCount: 1,
        menuCount: 1,
        categoryCount: 1,
        itemCount: 2,
        sampleItems: ["Rice"],
        gaps: [],
      },
      createdAt: new Date().toISOString(),
    };

    await saveDraft(draft);
    expect(await getDraft("draft-1")).toMatchObject({
      draftId: "draft-1",
      businessId: "business-1",
    });
  });
});
