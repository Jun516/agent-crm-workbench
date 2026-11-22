/** Synthetic OpenAI-compatible model: exercises the real Pi tool loop without a live provider. */
import { createServer, type Server } from "node:http";

export async function startOntologyModelFixture(
  port = Number(process.env.ONTOLOGY_FIXTURE_PORT ?? "48934"),
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as {
      messages: Array<{ role: string; content?: unknown }>;
      stream?: boolean;
      model?: string;
    };
    const messages = body.messages ?? [];
    const userText = messages
      .filter((item) => item.role === "user")
      .map((item) => JSON.stringify(item.content))
      .join(" ");
    const toolCount = messages.filter((item) => item.role === "tool").length;
    const mission = userText.includes("ONTOLOGY_MISSION");
    const target = userText.match(/ONTOLOGY_TARGET=([0-9a-f-]{36})/)?.[1];
    const afterTool = mission ? toolCount >= (target ? 3 : 2) : toolCount > 0;
    const partial = userText.includes("ONTOLOGY_PARTIAL");
    const unsupported = userText.includes("ONTOLOGY_UNANSWERABLE");
    const args = afterTool
      ? {
          summary: "Resultado sintético com evidência semântica.",
          evidence: [],
          missingInformation:
            partial || unsupported ? ["Definição comercial não certificada."] : [],
          nextStep: "Revisar o recibo.",
          wakeCondition: "none",
        }
      : mission
        ? (toolCount === 0 ? { capability: "crm_manage_tags" }
          : toolCount === 1 ? {} : { target_kind: "lead", target_id: target, add: ["synthetic"] })
        : partial
        ? {
            assumption: {
              minimumValueCents: 100000,
              currency: "BRL",
              from: "2026-10-31T00:00:00Z",
              to: "2026-11-14T00:00:00Z",
              activityTypes: ["appointment_completed"],
            },
          }
        : {
            question: unsupported
              ? "quais oportunidades de alto valor sem follow-up?"
              : "quais negócios estão abertos?",
          };
    const call = {
      index: 0,
      id: afterTool ? "call_result" : mission ? `call_mission_${toolCount}` : "call_ontology",
      type: "function",
      function: {
        name: afterTool ? "submit_workbench_result" : mission ? (toolCount === 0 ? "ontology_describe_action" : toolCount === 1 ? "ontology_describe_outcome" : "crm_manage_tags") : "ontology_query",
        arguments: JSON.stringify(args),
      },
    };
    const base = {
      id: "synthetic-ontology",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model ?? "synthetic",
    };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of [
        { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ])
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [call] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
