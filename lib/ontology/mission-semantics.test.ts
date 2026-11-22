import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeAction, describeOutcome, missionProposalScopeRefusal } from "./mission-semantics";
import { getToolByName } from "@/lib/mcp/tools";

describe("Mission planning semantics", () => {
  it("describes the registered authority without granting execution or inventing services", () => {
    const update = describeAction("crm_update_lead", getToolByName("crm_update_lead"));
    expect(update).toMatchObject({ role: "agent", scope: "mcp:write", effect: "reversible_write", authority: "app/api/v1/leads/_handler.ts#updateLeadHandler", grantsExecution: false });
    expect(describeAction("crm_create_lead", getToolByName("crm_create_lead"))).toMatchObject({ irreversible: true, authority: "app/api/v1/leads/_handler.ts#createLeadHandler" });
    for (const [name, authority] of [
      ["crm_send_whatsapp_message", "app/api/v1/messages/_handler.ts#sendMessageHandler"],
      ["crm_start_conversation_and_send", "lib/mcp/tools/start-conversation.ts#crmStartConversationAndSend"],
      ["crm_request_human_handoff", "lib/ai/handoff/orchestrator.ts#triggerHandoff"],
      ["crm_manage_tags", "lib/mcp/tools/governance.ts#crmManageTags"],
      ["crm_schedule_followup", "lib/followup/retorno-crm.ts#agendaRetornoNoCrm"],
    ]) {
      expect(describeAction(name!, getToolByName(name!))).toMatchObject({ authority, grantsExecution: false });
      const [path, symbol] = authority!.split("#");
      expect(readFileSync(path!, "utf8")).toContain(symbol!);
    }
    expect(describeAction("unknown", undefined)).toBeNull();
  });
  it("describes both contract checks without turning an inbound message into acceptance", () => {
    const result = describeOutcome({ revision: 1, checks: [ { kind: "lead_status", equals: "won" }, { kind: "customer_inbound_after_verified_send" } ] });
    expect(result.checks).toMatchObject([{ kind: "lead_status", expected: "won" }, { kind: "customer_inbound_after_verified_send" }]);
    expect(result.businessOutcomeVerified).toBe(false);
    expect(result.limitations.join(" ")).toContain("não prova concordância");
    expect(describeOutcome(null)).toMatchObject({ revision: null, checks: [], businessOutcomeVerified: false });
  });
  it("requires the explicitly selected opportunity for Mission writes and contact-only followup", () => {
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_update_lead", { lead_id: "lead-b" })).toMatchObject({ isError: true });
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_schedule_followup", { contact_id: "contact" })).toMatchObject({ isError: true });
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_update_lead", { lead_id: "lead-a" })).toBeNull();
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_schedule_followup", { lead_id: "lead-a", contact_id: "other" })).toMatchObject({ isError: true });
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_manage_tags", { target_kind: "lead", target_id: "lead-b" })).toMatchObject({ isError: true });
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_manage_tags", { target_kind: "lead", target_id: "lead-a" })).toBeNull();
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_manage_tags", { target_kind: "contact", target_id: "contact" })).toBeNull();
    expect(missionProposalScopeRefusal("mission", "lead-a", "contact", "conversation", "crm_request_human_handoff", { conversation_id: "other" })).toMatchObject({ isError: true });
    expect(missionProposalScopeRefusal(null, null, null, null, "crm_update_lead", { lead_id: "lead-b" })).toBeNull();
  });
});
