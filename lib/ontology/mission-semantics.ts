import type { MissionAcceptanceContract } from "@/lib/ai/evals/mission-acceptance-contract";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { IDS_DO_HARNESS } from "@/lib/mcp/tools/ferramentas-do-harness";
import type { McpToolDefinition } from "@/lib/mcp/types";

/** Descriptive metadata only; the registered handler and harness remain authoritative. */
export function describeAction(name: string, definition: McpToolDefinition | undefined) {
  const entry = catalogEntry(name);
  const effect = workbenchToolEffect(name);
  if (!entry || !definition || !effect) return null;
  const services: Record<string, string> = {
    crm_list_leads: "app/api/v1/leads/_handler.ts#listLeadsHandler",
    crm_get_lead: "app/api/v1/leads/_handler.ts#getLeadHandler",
    crm_create_lead: "app/api/v1/leads/_handler.ts#createLeadHandler",
    crm_update_lead: "app/api/v1/leads/_handler.ts#updateLeadHandler",
    crm_move_lead_stage: "app/api/v1/leads/_handler.ts#moveLeadHandler",
    crm_schedule_followup: "lib/followup/retorno-crm.ts#agendaRetornoNoCrm",
    crm_manage_tags: "lib/mcp/tools/governance.ts#crmManageTags",
    crm_send_whatsapp_message: "app/api/v1/messages/_handler.ts#sendMessageHandler",
    crm_start_conversation_and_send: "lib/mcp/tools/start-conversation.ts#crmStartConversationAndSend",
    crm_request_human_handoff: "lib/ai/handoff/orchestrator.ts#triggerHandoff",
  };
  const service = services[name] ?? null;
  return {
    capability: entry.name, object: entry.oQueToca, category: entry.category,
    risk: entry.risco, effect: effect.effect, role: definition.requiresRole,
    scope: definition.requiresScope, humanOnly: entry.apenasHumano === true,
    irreversible: effect.effect === "external" || effect.effect === "irreversible",
    reversibilityNote: name === "crm_update_lead" ? "Apenas campos com compensação suportada; outros permanecem para revisão humana." : null,
    authority: service, harnessOnly: IDS_DO_HARNESS.has(name),
    prerequisites: [
      "O objeto deve pertencer à organização e estar no escopo autorizado.",
      "O serviço, o Harness e a Mission verificam permissões, estado, versão, aprovação e idempotência antes de executar.",
      ...(IDS_DO_HARNESS.has(name) ? ["No turno do agente esta capacidade é operada pelo Harness, não diretamente pelo modelo."] : []),
      ...(name === "crm_send_whatsapp_message" ? ["A conversa deve existir; envio segue o serviço de mensagens e sua idempotência."] : []),
      ...(name === "crm_start_conversation_and_send" ? ["Exige sessão de canal explícita e contato ou telefone; abrir conversa e enviar são efeitos externos."] : []),
      ...(name === "crm_request_human_handoff" ? ["Exige conversa da organização; destino depende de elegibilidade ou fila. Em Mission, a conversa e o negócio devem estar explicitamente vinculados."] : []),
      ...(name === "crm_manage_tags" ? ["O alvo deve existir na organização; informe ao menos uma etiqueta para adicionar ou remover."] : []),
      ...(name === "crm_move_lead_stage" ? ["A etapa de destino deve pertencer ao mesmo funil."] : []),
      ...(name === "crm_schedule_followup" ? ["O negócio precisa ter contato; o horário e a unicidade do retorno são conferidos pelo serviço."] : []),
      ...(service ? [] : ["Serviço específico não mapeado; consulte o handler registrado."]),
    ],
    grantsExecution: false,
  };
}

/** Contract describes evidence requirements, not an evaluation or proof of success. */
export function describeOutcome(contract: MissionAcceptanceContract | null) {
  return {
    revision: contract?.revision ?? null,
    checks: (contract?.checks ?? []).map((check) => check.kind === "lead_status"
      ? { kind: check.kind, expected: check.equals, signal: "Estado atual do negócio da Mission", evidence: "Registro CRM do negócio no escopo da organização" }
      : { kind: check.kind, signal: "Texto de entrada posterior ao envio verificado", evidence: "Aprovação, ledger de envio, mensagem CRM e entrada posterior na mesma conversa" }),
    limitations: [
      "Consulta correta, ferramenta executada, canal aceitou, cliente confirmou e objetivo concluído são fatos distintos.",
      "Entrada do cliente não prova concordância; texto livre e objetivo comercial não são verificados por este contrato.",
      "Uma proposta de processo do modelo não concede autoridade de execução.",
    ],
    businessOutcomeVerified: false,
  };
}

/** A Mission is bound to exactly one explicitly selected and validated opportunity. */
export function missionProposalScopeRefusal(missionId: string | null, leadId: string | null, contactId: string | null, conversationId: string | null, tool: string, args: unknown) {
  if (!missionId || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const fields = args as Record<string, unknown>;
  if (tool === "crm_request_human_handoff" && (!conversationId || fields.conversation_id !== conversationId))
    return { content: "Selecione a conversa vinculada à Mission antes de propor transferência.", isError: true };
  const target = tool === "crm_manage_tags" && fields.target_kind === "lead"
    ? fields.target_id : fields.lead_id;
  if (tool === "crm_schedule_followup" && fields.contact_id != null && fields.contact_id !== contactId)
    return { content: "O contato não corresponde ao negócio selecionado; esclareça o alvo.", isError: true };
  if (target === undefined && tool !== "crm_schedule_followup" &&
      !(tool === "crm_manage_tags" && fields.target_kind === "lead")) return null;
  if (typeof target === "string" && leadId && target === leadId) return null;
  return { content: "A ação precisa usar o negócio explicitamente selecionado para a Mission. Esclareça o alvo; nenhum negócio foi alterado.", isError: true };
}
