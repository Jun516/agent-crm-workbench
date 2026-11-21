import { z } from "zod";
import type { McpToolDefinition, McpContext } from "../types";
import { resolveTerms } from "@/lib/ontology/resolve-terms";
import { checkAnswerable, planExplicitActivityGap, planQuery } from "@/lib/ontology/query-plan";
import { executeMcpReadPlan } from "@/lib/ontology/execute-mcp-read-plan";
import { describeAction, describeOutcome } from "@/lib/ontology/mission-semantics";
import { parseMissionAcceptanceContract } from "@/lib/ai/evals/mission-acceptance-contract";
import { executeRuntimeReadPlan } from "@/lib/ontology/execute-runtime-read-plan";

const question = { question: z.string().min(1).max(2000) };
const common = {
  requiresRole: "agent" as const,
  requiresScope: "mcp:read" as const,
};
const unavailable = {
  kind: "ontology_observation",
  status: "unanswerable",
  degraded: true,
  missing: [
    "Serviço semântico indisponível; use ferramentas de leitura existentes e informe a limitação.",
  ],
};

export const ontologySearchTerms: McpToolDefinition<typeof question> = {
  ...common,
  category: "read",
  name: "ontology_search_terms",
  description:
    "Busca conceitos no catálogo publicado; correspondência não certifica definição comercial.",
  inputSchema: question,
  handler: async ({ question }) => {
    try {
      return { kind: "ontology_observation", degraded: false, ...resolveTerms(question) };
    } catch {
      return unavailable;
    }
  },
};
export const ontologyCheckAnswerable: McpToolDefinition<typeof question> = {
  ...common,
  category: "read",
  name: "ontology_check_answerable",
  description:
    "Verifica se uma pergunta corresponde a uma consulta revisada e identifica definições ausentes.",
  inputSchema: question,
  handler: async ({ question }) => {
    try {
      const result = checkAnswerable(question);
      return { kind: "ontology_observation", degraded: result.status !== "supported", ...result };
    } catch {
      return unavailable;
    }
  },
};
const queryShape = {
  question: z.string().min(1).max(2000).optional(),
  assumption: z
    .object({
      minimumValueCents: z.number().int().nonnegative(),
      currency: z.string(),
      from: z.string(),
      to: z.string(),
      activityTypes: z.array(z.enum(["appointment_completed", "voice_call", "task_completed"])),
    })
    .strict()
    .optional(),
};
export const ontologyQuery: McpToolDefinition<typeof queryShape> = {
  ...common,
  category: "read",
  name: "ontology_query",
  description:
    "Consulta somente modelos revisados. Para lacuna de atividades, use apenas critérios fornecidos explicitamente pelo usuário, rotule como hipótese e nunca como definição certificada; se faltarem, peça esclarecimento. Em degradação use as ferramentas de leitura existentes e informe a limitação. Não aceita SQL, organização ou escopo.",
  inputSchema: queryShape,
  motivoDoVazio: (result) =>
    (result as { degraded?: boolean }).degraded
      ? "semantica_indisponivel_ou_nao_certificada"
      : null,
  handler: async (input, ctx: McpContext) => {
    try {
      if (Boolean(input.question) === Boolean(input.assumption)) return unavailable;
      const plan = input.assumption
        ? planExplicitActivityGap(input.assumption)
        : planQuery(input.question!);
      if (!plan)
        return {
          kind: "ontology_observation",
          status: "unanswerable",
          degraded: true,
          missing: checkAnswerable(input.question!).missing,
          nextStep:
            "Peça esclarecimento ou use ferramentas de leitura existentes, informando os limites.",
        };
      if (
        ctx.ontologyRuntime &&
        ctx.ontologyRuntime.pipelineIds !== null &&
        ctx.ontologyRuntime.pipelineIds.length === 0
      )
        return {
          kind: "ontology_observation",
          status: "unanswerable",
          degraded: true,
          missing: [
            "Nenhum funil de leitura disponível. Selecione um funil na bancada ou esclareça o escopo.",
          ],
        };
      const result = ctx.ontologyRuntime
        ? await executeRuntimeReadPlan(plan, ctx, ctx.ontologyRuntime, ctx.ontologyRuntime.signal)
        : await executeMcpReadPlan(plan, ctx, ctx.signal);
      return {
        kind: "ontology_observation",
        status: result.receipt.partial ? "partial" : "full",
        degraded: false,
        assumption: Boolean(input.assumption),
        ...result,
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const reason =
        code === "ontology_forbidden"
          ? "Acesso semântico recusado."
          : code === "ontology_cancelled"
            ? "Consulta cancelada."
            : code === "ontology_timeout"
              ? "Tempo de consulta esgotado."
              : "Serviço semântico indisponível; use ferramentas de leitura existentes e informe a limitação.";
      return { ...unavailable, missing: [reason] };
    }
  },
};

const actionShape = { capability: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100) };
export const ontologyDescribeAction: McpToolDefinition<typeof actionShape> = {
  ...common, name: "ontology_describe_action",
  category: "read",
  description: "Descreve uma capacidade CRM registrada e suas condições; não autoriza ou executa ações.",
  inputSchema: actionShape,
  handler: async ({ capability }) => {
    const { getToolByName } = await import("./index");
    const action = describeAction(capability, getToolByName(capability));
    return action
      ? { kind: "ontology_observation", status: action.authority ? "supported" : "partial",
          degraded: !action.authority, action,
          ...(action.authority ? {} : { missing: ["Serviço específico não mapeado; consulte o handler registrado."] }) }
      : { ...unavailable, missing: ["Capacidade não registrada ou sem classificação."] };
  },
};
const outcomeShape = {};
export const ontologyDescribeOutcome: McpToolDefinition<typeof outcomeShape> = {
  ...common, name: "ontology_describe_outcome",
  category: "read",
  description: "Descreve o contrato da Mission deste Run e os limites da evidência; não avalia sucesso.",
  inputSchema: outcomeShape,
  handler: async (_input, ctx) => {
    const runId = ctx.ontologyRuntime?.workbenchRunId;
    if (!runId) return { ...unavailable, missing: ["Nenhuma Mission vinculada ao Run confiável."] };
    try {
      const run = await ctx.supabase.from("ai_workbench_runs").select("mission_id")
        .eq("organization_id", ctx.organizationId).eq("id", runId).maybeSingle();
      if (run.error || !run.data?.mission_id) return { ...unavailable, missing: ["Nenhuma Mission vinculada ao Run confiável."] };
      const mission = await ctx.supabase.from("ai_missions").select("acceptance_contract")
        .eq("organization_id", ctx.organizationId).eq("id", run.data.mission_id).maybeSingle();
      if (mission.error || !mission.data) return unavailable;
      const outcome = describeOutcome(parseMissionAcceptanceContract(mission.data.acceptance_contract));
      return { kind: "ontology_observation", status: "supported", degraded: false, outcome };
    } catch { return unavailable; }
  },
};
