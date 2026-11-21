import { expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { resolvePiModel } from "@/lib/agent-runtime/pi/model-adapter";
import { startOntologyModelFixture } from "@/tests/e2e/helpers/ontology-model-fixture";

it("drives a real Pi OpenRouter adapter with the synthetic chat completion stream", async () => {
  const fixture = await startOntologyModelFixture(0);
  try {
    const resolved = await resolvePiModel({
      provider: "openrouter",
      model: "synthetic/ontology",
      apiKey: "fixture",
      baseUrl: fixture.baseUrl,
    });
    const stream = await resolved.streamFn(
      resolved.model,
      normalizeContext({
        messages: [{ role: "user", content: "ONTOLOGY_FULL", timestamp: Date.now() }],
      }),
      undefined,
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "toolCall", name: "ontology_query" }),
      ]),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
