/** Native Pi request fixture; no external provider or customer credentials. */
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
export function memoryRequestRuntime(
  response = "Fixture answer; no external model",
  onRequest?: (context: unknown) => void,
) {
  const faux = fauxProvider({ provider: "memory-fixture", models: [{ id: "memory-fixture" }] });
  faux.setResponses([fauxAssistantMessage(response)]);
  const stream = faux.provider.streamSimple.bind(faux.provider);
  const streamFn = (...args: Parameters<typeof stream>) => {
    onRequest?.(args[1]);
    return stream(...args);
  };
  return new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: streamFn as never,
  }));
}
