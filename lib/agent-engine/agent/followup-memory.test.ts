import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { LeadContext } from "../edge/crm/get-lead-context";

vi.mock("@/lib/env", () => ({ env: {} }));
const execute = vi.hoisted(() => vi.fn());
vi.mock("./pi-turn-execution", () => ({ executePiTurnModelCall: execute }));
vi.mock("./fuso-da-org", () => ({ fusoDaOrganizacao: async () => "UTC" }));
import { planFollowupTiming } from "./followup-flow-classify";

const context: LeadContext = {
  lead_id: "contact-1",
  contact_id: "contact-1",
  conversation_id: "conversation-1",
  contact: { name: "Fixture", phone: null, email: null, tags: [], is_blocked: false },
  last_human_decision: null,
  messages: [],
};
const db = {} as pg.Pool;
const ids = { tenantId: "org-1", leadId: "contact-1", jobId: "job-1" };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() =>
  execute.mockReset().mockResolvedValue({
    result: { text: '{"esperas":[{"node_id":"w1","aguardar_ms":60000,"motivo":"daytime"}]}' },
    model: "fixture",
  }),
);

describe("follow-up timing confirmed-memory wiring", () => {
  it("keeps the configured purpose and binds request-time memory to the originating conversation", async () => {
    const beforeRead = vi.fn().mockResolvedValue(undefined);
    const result = await planFollowupTiming(
      db,
      {},
      ids,
      {
        context,
        esperas: [{ node_id: "w1", label: "First wait", min_ms: 60000, max_ms: 3600000 }],
      },
      { log, beforeRead },
    );
    expect(result.propostas[0]?.node_id).toBe("w1");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: db,
        customerMemory: expect.objectContaining({
          contactId: ids.leadId,
          conversationId: context.conversation_id,
          beforeRead,
          task: expect.stringMatching(/follow.?up|seguimento|contato/i),
        }),
      }),
      expect.objectContaining({ ...ids, purpose: "followup_decide_timing" }),
    );
  });

  it.each([
    { ...context, lead_id: "foreign" },
    { ...context, contact_id: "foreign" },
  ])("rejects a different subject before serializing customer context", async (foreign) => {
    await expect(
      planFollowupTiming(db, {}, ids, { context: foreign, esperas: [] }, { log }),
    ).rejects.toThrow("customer_memory_scope_invalid");
    expect(execute).not.toHaveBeenCalled();
  });
});
