import { describe, expect, it } from "vitest";

import {
  projetarContexto,
  projetarRetornoDeTool,
  traduzirErroCru,
  turnoProjeta,
} from "@/lib/agent-engine/agent/projecao";
import { detectarVazamentoInterno } from "@/lib/agent-engine/guardrails/vazamento-interno";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

// Recortes dos resultados de ferramenta dos cenários 7 e 9 da medição de
// 2026-08-05 (spec 16 §4). Mantêm os campos e o aninhamento do vazamento com
// identificadores fictícios, para testar a regressão em um clone público.
const RESULTADOS_AUTOMACAO = [
  { regras: [{ id: "00000000-0000-4000-8000-000000000001" }] },
  {
    execucoes: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        falhas: [{ erro: "unsafe_url:https_required" }],
      },
    ],
  },
];
const RESULTADOS_PERMISSOES = [
  { time: [{ user_id: "00000000-0000-4000-8000-000000000003" }] },
];

const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("projeção — o que o Conversador pode ver", () => {
  describe("o interruptor", () => {
    it("arma quando NENHUMA ferramenta de catálogo entrou no turno", () => {
      expect(turnoProjeta([])).toBe(true);
    });

    it("NÃO arma quando há ferramenta de catálogo — ela precisa dos ids como argumento", () => {
      // Removê-los aqui quebraria a operação: `crm_move_lead_stage` recebe
      // `lead_id: z.string().uuid()`. Quem cobre neste turno é o gate de saída.
      expect(turnoProjeta(["crm_list_leads"])).toBe(false);
    });
  });

  describe("contexto do lead", () => {
    const cru: LeadContext = {
      lead_id: "580460c9-98a7-40c5-8a67-c3eb41f69237",
      contact: {
        name: "Maria",
        phone: "+5511999999999",
        email: "maria@exemplo.com",
        tags: ["vip"],
        is_blocked: false,
      },
      conversation_id: "7981d2ae-ad34-48d9-815b-3bf4d2e5d7f1",
      last_human_decision: { action: "enviar orçamento", decision: "dismissed", at: "2026-08-01T10:00:00Z" },
      messages: [
        { direction: "inbound", body: "oi, quero remarcar", sent_at: "2026-08-05T10:00:00Z" },
        {
          direction: "outbound",
          body: "claro!",
          sent_at: "2026-08-05T10:01:00Z",
          type: "image",
          media_storage_path: "whatsapp-media/org/abc.jpg",
          media_mime: "image/jpeg",
        },
      ],
    };

    it("nenhum UUID sobrevive — foi por eles que id de usuário chegou à tela do cliente", () => {
      const json = JSON.stringify(projetarContexto(cru));
      expect(json).not.toMatch(RE_UUID);
    });

    it("o caminho de storage da mídia some, mas o FATO de haver mídia fica", () => {
      const p = projetarContexto(cru);
      expect(JSON.stringify(p)).not.toContain("whatsapp-media");
      // Perder o anexo faria o agente responder como se a pessoa não tivesse
      // mandado nada — proteger virando burro não é proteger.
      expect(p.mensagens[1]!.anexo).toBe("[image]");
    });

    it("dado da PESSOA fica: nome, telefone, e-mail e marcadores", () => {
      const p = projetarContexto(cru);
      expect(p.contato).toEqual({
        nome: "Maria",
        telefone: "+5511999999999",
        email: "maria@exemplo.com",
        marcadores: ["vip"],
      });
    });

    it("'inbound'/'outbound' viram 'cliente'/'nós' — quem fala com gente não pensa em direção", () => {
      const p = projetarContexto(cru);
      expect(p.mensagens.map((m) => m.de)).toEqual(["cliente", "nós"]);
      expect(JSON.stringify(p)).not.toContain("inbound");
    });

    it("is_blocked não vaza — quando é true o turno nem chega ao modelo", () => {
      expect(JSON.stringify(projetarContexto(cru))).not.toContain("is_blocked");
    });

    it("a decisão humana chega TRADUZIDA e sem o vocabulário do banco", () => {
      const p = projetarContexto(cru);
      expect(p.ultima_decisao_humana).toEqual({
        sobre: "enviar orçamento",
        decisao: "recusada",
        quando: "2026-08-01T10:00:00Z",
      });
      expect(JSON.stringify(p)).not.toContain("dismissed");
    });

    it("a FALA do cliente passa intacta, mesmo carregando palavra de sistema", () => {
      // Regressão do bug que quase entrou: aplicar a tradução de erro ao corpo
      // reescreveria o cliente. "Meu site tem um webhook quebrado" é frase
      // legítima de quem vende integração; traduzi-la faria o agente responder
      // a uma pergunta que ninguém fez.
      const comJargao: LeadContext = {
        ...cru,
        messages: [{ direction: "inbound", body: "meu webhook parou de funcionar", sent_at: "2026-08-05T10:00:00Z" }],
      };
      expect(projetarContexto(comJargao).mensagens[0]!.texto).toBe("meu webhook parou de funcionar");
    });

    it("campo novo no contexto NÃO passa por omissão — allowlist falha fechado", () => {
      // Uma denylist deixaria o campo novo chegar ao cliente até alguém lembrar
      // de bani-lo. Aqui o default é não aparecer.
      const comCampoNovo = { ...cru, internal_risk_score: 0.97, owner_user_id: "abc" } as LeadContext;
      const json = JSON.stringify(projetarContexto(comCampoNovo));
      expect(json).not.toContain("internal_risk_score");
      expect(json).not.toContain("owner_user_id");
    });
  });

  describe("tradução de erro cru", () => {
    it("o erro MEDIDO em produção vira consequência que a pessoa entende", () => {
      const traduzido = traduzirErroCru("unsafe_url:https_required");
      expect(traduzido).toContain("não usa conexão segura");
      expect(traduzido).not.toContain("unsafe_url");
    });

    it("erro desconhecido COM vocabulário interno falha fechado", () => {
      // O pior momento para deixar passar é justamente aquele em que não se
      // sabe o que o texto revela.
      const t = traduzirErroCru("pg_error: relation crm_lead_activities does not exist");
      expect(detectarVazamentoInterno(t).achou).toBe(false);
    });

    it("texto limpo passa INTACTO — a projeção não pode empobrecer o que já estava bom", () => {
      const limpo = "não encontrei nenhuma consulta marcada para esta semana";
      expect(traduzirErroCru(limpo)).toBe(limpo);
    });
  });

  describe("retorno de ferramenta", () => {
    it("chaves de identificador somem com o valor junto", () => {
      const projetado = projetarRetornoDeTool({
        ok: true,
        results: [{ chunk_id: "abc-123", knowledge_source_id: "def-456", content: "texto", similarity: 0.9 }],
      });
      const json = JSON.stringify(projetado);
      expect(json).not.toContain("chunk_id");
      expect(json).not.toContain("knowledge_source_id");
      expect(json).toContain("texto");
    });

    it("o CONTEÚDO da base de conhecimento sobrevive intacto, mesmo falando 'webhook'", () => {
      // Regressão de um bug que entrou e foi pego pela sabotagem: a tradução
      // era aplicada a TODA string. O detector considera "webhook" vazamento
      // (com razão, na SAÍDA), e a FAQ de qualquer empresa que venda integração
      // fala webhook — o RAG do tenant viraria "não consegui concluir essa
      // verificação" linha após linha. Filtro de texto do sistema não pode
      // pisar em texto de terceiro.
      const trecho = "Para integrar, configure o webhook no painel e informe a URL de callback.";
      const p = projetarRetornoDeTool({ ok: true, results: [{ content: trecho, similarity: 0.9 }] }) as {
        results: Array<{ content: string }>;
      };
      expect(p.results[0]!.content).toBe(trecho);
    });

    it("mas o campo de ERRO continua sendo traduzido — a restrição não desarmou a defesa", () => {
      const p = projetarRetornoDeTool({ execucoes: [{ erro: "unsafe_url:https_required" }] }) as {
        execucoes: Array<{ erro: string }>;
      };
      expect(p.execucoes[0]!.erro).toContain("não usa conexão segura");
    });

    it("a estrutura ok/error sobrevive — é por ela que o runtime ensina o modelo", () => {
      // Removê-la cegaria o loop de correção que esta base usa em toda tool.
      const p = projetarRetornoDeTool({ ok: false, error: { code: "no_knowledge_base", message: "siga sem ela." } }) as {
        ok: boolean;
        error: { message: string };
      };
      expect(p.ok).toBe(false);
      expect(p.error.message).toBe("siga sem ela.");
    });
  });

  describe("regressões observadas nos turnos medidos", () => {
    it("o payload que produziu 'unsafe_url:https_required' sai limpo depois da projeção", () => {
      const cruJson = JSON.stringify(RESULTADOS_AUTOMACAO);
      expect(cruJson, "controle: o payload deve conter o erro cru").toContain("unsafe_url:https_required");

      const projetadoJson = JSON.stringify(projetarRetornoDeTool(RESULTADOS_AUTOMACAO));
      expect(projetadoJson).not.toContain("unsafe_url");
      expect(projetadoJson).not.toContain("https_required");
      expect(projetadoJson).toContain("não usa conexão segura");
    });

    it("os UUIDs que o mesmo turno trazia não sobrevivem", () => {
      expect(JSON.stringify(RESULTADOS_AUTOMACAO), "controle").toMatch(RE_UUID);
      expect(JSON.stringify(projetarRetornoDeTool(RESULTADOS_AUTOMACAO))).not.toMatch(RE_UUID);
    });

    it("o turno que despejou UUID de usuário na tela do cliente sai sem nenhum", () => {
      expect(JSON.stringify(RESULTADOS_PERMISSOES), "controle").toMatch(RE_UUID);
      expect(JSON.stringify(projetarRetornoDeTool(RESULTADOS_PERMISSOES))).not.toMatch(RE_UUID);
    });
  });
});
