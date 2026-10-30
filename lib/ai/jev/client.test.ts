/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import {
  evaluateJevChoices,
  JEV_ENDPOINT,
  JEV_MAX_REQUEST_BYTES,
  JEV_MAX_RESPONSE_BYTES,
  JevClientError,
  type JevChoiceQuestion,
} from "./client";

const questions: Record<string, JevChoiceQuestion> = {
  category: {
    type: "choice",
    instructions: "Classify the supplied metric evidence.",
    criteria: {
      alert: "Observed anomaly",
      normal: "Observed normal metrics",
      uncertain: "Evidence is incomplete",
    },
  },
};

function payload() {
  return {
    model: "jev-1.13.0",
    answers: {
      category: {
        type: "choice",
        choice: "alert",
        confidence: 0.85,
        probabilities: { alert: 0.9, normal: 0.06, uncertain: 0.04 },
      },
    },
    usage: { input_tokens: 80, output_tokens: 12 },
  };
}

function call(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof evaluateJevChoices>[0]> = {},
) {
  return evaluateJevChoices({
    state: { errors: 5 },
    questions,
    options: { apiKey: "unit-test-key", model: "jev-1.13.0", fetchImpl },
    ...overrides,
  });
}

function reply(value: unknown = payload()) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("Jev bounded Choice protocol client", () => {
  it("posts the documented wire shape to the fixed endpoint without retries/redirects", async () => {
    const fetcher = reply({ ...payload(), future_metadata: { ignored: true } });
    const result = await call(fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer unit-test-key",
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "jev-1.13.0",
      state: { errors: 5 },
      questions,
    });
    expect(result.answers.category).toEqual(payload().answers.category);
    // Confidence and the selected probability have distinct meanings.
    expect(result.answers.category!.confidence).not.toBe(
      result.answers.category!.probabilities.alert,
    );
    expect(result.usage).toEqual({ input_tokens: 80, output_tokens: 12 });
    expect(result.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("future_metadata");
  });

  it("resolves a documented alias but rejects drift from an explicitly pinned version", async () => {
    const result = await call(reply(), {
      options: {
        apiKey: "test",
        model: "jev-latest",
        fetchImpl: reply(),
      },
    });
    expect(result.model).toBe("jev-1.13.0");
    await expect(call(reply({ ...payload(), model: "jev-1.14.0" }))).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("fingerprints evidence and resolved version, never credentials", async () => {
    const a = await call(reply());
    const b = await call(reply(), {
      options: { apiKey: "other-key", model: "jev-1.13.0", fetchImpl: reply() },
    });
    const c = await call(reply(), { state: { errors: 6 } });
    expect(a.requestFingerprint).toBe(b.requestFingerprint);
    expect(a.requestFingerprint).not.toBe(c.requestFingerprint);
    expect(JSON.stringify(a)).not.toContain("unit-test-key");
  });

  it("validates against the sent model and question snapshot, not later caller mutations", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const mutable = structuredClone(questions);
    const options = { apiKey: "test", model: "jev-1.13.0", fetchImpl: fetcher };
    const pending = call(fetcher, { questions: mutable, options });
    mutable.category!.criteria = { execute: "different question" };
    options.model = "jev-1.14.0";
    resolve(new Response(JSON.stringify(payload())));
    expect((await pending).model).toBe("jev-1.13.0");
  });

  const malformed: Array<[string, () => unknown]> = [
    ["missing question", () => ({ ...payload(), answers: {} })],
    [
      "extra question",
      () => ({
        ...payload(),
        answers: { ...payload().answers, extra: payload().answers.category },
      }),
    ],
    [
      "wrong answer type",
      () => ({
        ...payload(),
        answers: { category: { ...payload().answers.category, type: "score" } },
      }),
    ],
    [
      "unpermitted choice",
      () => ({
        ...payload(),
        answers: { category: { ...payload().answers.category, choice: "execute" } },
      }),
    ],
    [
      "choice is not highest probability",
      () => ({
        ...payload(),
        answers: { category: { ...payload().answers.category, choice: "normal" } },
      }),
    ],
    [
      "missing probability",
      () => ({
        ...payload(),
        answers: {
          category: { ...payload().answers.category, probabilities: { alert: 0.9, normal: 0.1 } },
        },
      }),
    ],
    [
      "extra probability",
      () => ({
        ...payload(),
        answers: {
          category: {
            ...payload().answers.category,
            probabilities: { ...payload().answers.category.probabilities, execute: 0 },
          },
        },
      }),
    ],
    [
      "invalid distribution",
      () => ({
        ...payload(),
        answers: {
          category: {
            ...payload().answers.category,
            probabilities: { alert: 0.2, normal: 0.2, uncertain: 0.2 },
          },
        },
      }),
    ],
    [
      "negative probability",
      () => ({
        ...payload(),
        answers: {
          category: {
            ...payload().answers.category,
            probabilities: { alert: 1, normal: -0.1, uncertain: 0.1 },
          },
        },
      }),
    ],
    [
      "invalid confidence",
      () => ({
        ...payload(),
        answers: { category: { ...payload().answers.category, confidence: 1.1 } },
      }),
    ],
    [
      "nonfinite confidence",
      () => ({
        ...payload(),
        answers: { category: { ...payload().answers.category, confidence: NaN } },
      }),
    ],
    ["fractional usage", () => ({ ...payload(), usage: { input_tokens: 1.5, output_tokens: 0 } })],
    ["negative usage", () => ({ ...payload(), usage: { input_tokens: 1, output_tokens: -1 } })],
    ["unrelated model", () => ({ ...payload(), model: "https://evil.invalid/model" })],
  ];
  it.each(malformed)("rejects %s", async (_label, value) => {
    await expect(call(reply(value()))).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("does not send missing configuration, malformed questions or non-JSON state", async () => {
    const fetcher = reply();
    await expect(
      call(fetcher, { options: { apiKey: "", model: "jev-latest", fetchImpl: fetcher } }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    await expect(call(fetcher, { questions: {} })).rejects.toMatchObject({ code: "input_invalid" });
    await expect(call(fetcher, { state: { value: Infinity } })).rejects.toMatchObject({
      code: "input_invalid",
    });
    await expect(call(fetcher, { state: { value: () => "secret" } })).rejects.toMatchObject({
      code: "input_invalid",
    });
    await expect(
      call(fetcher, {
        options: { apiKey: "test", model: "https://bad.invalid", fetchImpl: fetcher },
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds the request before sending any network traffic", async () => {
    const fetcher = reply();
    await expect(call(fetcher, { state: "x".repeat(JEV_MAX_REQUEST_BYTES) })).rejects.toMatchObject(
      { code: "request_too_large" },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds streamed responses even without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(JEV_MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(call(fetcher)).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("rejects oversized declared bodies and invalid UTF-8/JSON", async () => {
    const declared = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: { "Content-Length": String(JEV_MAX_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(call(declared)).rejects.toMatchObject({ code: "response_too_large" });
    const corrupt = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff])));
    await expect(call(corrupt)).rejects.toMatchObject({ code: "response_invalid" });
    await expect(
      call(vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json"))),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("never exposes upstream messages and never retries billable errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret-provider-body", { status: 429 }));
    await expect(call(fetcher)).rejects.toEqual(new JevClientError("http_error"));
    expect(fetcher).toHaveBeenCalledOnce();
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Authorization: secret-key"));
    await expect(call(transport)).rejects.toEqual(new JevClientError("transport_error"));
    expect(transport).toHaveBeenCalledOnce();
  });

  it("honors a caller cancellation before or during the request", async () => {
    const before = new AbortController();
    before.abort();
    const notSent = reply();
    await expect(call(notSent, { signal: before.signal })).rejects.toMatchObject({
      code: "request_aborted",
    });
    expect(notSent).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = call(fetcher, { signal: during.signal });
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: "request_aborted" });
  });

  it("times out even if an injected transport ignores AbortSignal", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    await expect(
      call(fetcher, {
        options: { apiKey: "test", model: "jev-latest", timeoutMs: 50, fetchImpl: fetcher },
      }),
    ).rejects.toMatchObject({ code: "request_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("consumes a transport rejection when cancellation occurs during dispatch", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("secret transport message"));
    });
    await expect(call(fetcher, { signal: controller.signal })).rejects.toMatchObject({
      code: "request_aborted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("keeps the timeout active while reading a stalled body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start() {} })));
    await expect(
      call(fetcher, {
        options: { apiKey: "test", model: "jev-latest", timeoutMs: 50, fetchImpl: fetcher },
      }),
    ).rejects.toMatchObject({ code: "request_timeout" });
  });
});
