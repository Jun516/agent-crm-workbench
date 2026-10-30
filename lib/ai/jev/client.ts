import { createHash } from "node:crypto";

/** Text-only Choice adapter for the documented TypeSafe System One endpoint. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_CLIENT_REVISION = "jev-choice-v1";
export const JEV_MAX_REQUEST_BYTES = 96 * 1024;
export const JEV_MAX_RESPONSE_BYTES = 128 * 1024;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevChoiceResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  requestFingerprint: string;
}

export interface JevClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type JevClientErrorCode =
  | "input_invalid"
  | "config_invalid"
  | "request_too_large"
  | "request_aborted"
  | "request_timeout"
  | "transport_error"
  | "http_error"
  | "response_too_large"
  | "response_invalid";

/** Never includes a key, request state, upstream message or response body. */
export class JevClientError extends Error {
  constructor(readonly code: JevClientErrorCode) {
    super(code);
    this.name = "JevClientError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const namePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const modelPattern = /^jev-[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validJson(value: unknown, depth = 0, count = { value: 0 }): boolean {
  if (depth > 20 || ++count.value > 20_000) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => validJson(item, depth + 1, count));
  return object(value) && Object.values(value).every((item) => validJson(item, depth + 1, count));
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validUsage(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requestBody(state: unknown, questions: Record<string, JevChoiceQuestion>, model: string) {
  if (
    !(typeof state === "string" || Array.isArray(state) || object(state)) ||
    !validJson(state) ||
    !object(questions)
  )
    throw new JevClientError("input_invalid");
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > 32) throw new JevClientError("input_invalid");
  for (const [id, question] of entries) {
    if (
      !namePattern.test(id) ||
      !object(question) ||
      !sameKeys(question, ["type", "instructions", "criteria"]) ||
      question.type !== "choice" ||
      typeof question.instructions !== "string" ||
      !question.instructions.trim() ||
      question.instructions.length > 8_000 ||
      !object(question.criteria)
    )
      throw new JevClientError("input_invalid");
    const options = Object.entries(question.criteria);
    if (
      options.length < 1 ||
      options.length > 255 ||
      options.some(
        ([key, description]) =>
          !namePattern.test(key) ||
          typeof description !== "string" ||
          !description.trim() ||
          description.length > 4_000,
      )
    )
      throw new JevClientError("input_invalid");
  }
  const body = JSON.stringify({ model, state, questions });
  if (Buffer.byteLength(body, "utf8") > JEV_MAX_REQUEST_BYTES)
    throw new JevClientError("request_too_large");
  return body;
}

function decodeResponse(
  raw: unknown,
  questions: Record<string, JevChoiceQuestion>,
  requestedModel: string,
) {
  if (
    !object(raw) ||
    typeof raw.model !== "string" ||
    !modelPattern.test(raw.model) ||
    !object(raw.answers) ||
    !sameKeys(raw.answers, Object.keys(questions)) ||
    !object(raw.usage) ||
    !validUsage(raw.usage.input_tokens) ||
    !validUsage(raw.usage.output_tokens)
  )
    throw new JevClientError("response_invalid");
  // A documented alias may resolve to a concrete version. Explicit versions
  // must match; callers must pin a version or avoid alias-based cache reuse.
  if (/^jev-\d+\.\d+\.\d+$/.test(requestedModel) && raw.model !== requestedModel)
    throw new JevClientError("response_invalid");
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    const keys = Object.keys(question.criteria);
    if (
      !object(answer) ||
      answer.type !== "choice" ||
      typeof answer.choice !== "string" ||
      !keys.includes(answer.choice) ||
      !probability(answer.confidence) ||
      !object(answer.probabilities) ||
      !sameKeys(answer.probabilities, keys)
    )
      throw new JevClientError("response_invalid");
    const probabilities = answer.probabilities;
    const values = Object.values(probabilities);
    if (
      !values.every(probability) ||
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001 + Number.EPSILON
    )
      throw new JevClientError("response_invalid");
    const selected = probabilities[answer.choice] as number;
    if (selected + 1e-9 < Math.max(...values)) throw new JevClientError("response_invalid");
    answers[id] = {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: Object.fromEntries(keys.map((key) => [key, probabilities[key] as number])),
    };
  }
  return {
    model: raw.model,
    answers,
    usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      // The transport/read may already have rejected while constructing its
      // promise. Consume it even when cancellation won before subscription.
      void promise.catch(() => undefined);
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > JEV_MAX_RESPONSE_BYTES)
    throw new JevClientError("response_too_large");
  if (!response.body) throw new JevClientError("response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > JEV_MAX_RESPONSE_BYTES) throw new JevClientError("response_too_large");
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new JevClientError("response_invalid");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* A pending cancelled read can own the lock. */
    }
  }
}

export async function evaluateJevChoices(input: {
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
  options: JevClientOptions;
  signal?: AbortSignal;
}): Promise<JevChoiceResponse> {
  const { options } = input;
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (
    !options.apiKey?.trim() ||
    options.apiKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(options.apiKey) ||
    !modelPattern.test(options.model) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 30_000
  )
    throw new JevClientError("config_invalid");
  if (input.signal?.aborted) throw new JevClientError("request_aborted");
  let body: string;
  try {
    body = requestBody(input.state, input.questions, options.model);
  } catch (error) {
    throw error instanceof JevClientError ? error : new JevClientError("input_invalid");
  }
  // Validate the response against the immutable wire request, even if a caller
  // later changes a shared question object while the request is in flight.
  const sent = JSON.parse(body) as { model: string; questions: Record<string, JevChoiceQuestion> };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  let response: Response | undefined;
  try {
    response = await abortable(
      (options.fetchImpl ?? fetch)(JEV_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey.trim()}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body,
      }),
      signal,
    );
    if (!response.ok) throw new JevClientError("http_error");
    const text = await boundedResponse(response, signal);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new JevClientError("response_invalid");
    }
    const result = decodeResponse(raw, sent.questions, sent.model);
    return {
      ...result,
      requestFingerprint: createHash("sha256")
        .update(
          JSON.stringify({ revision: JEV_CLIENT_REVISION, body, resolvedModel: result.model }),
        )
        .digest("hex"),
    };
  } catch (error) {
    if (input.signal?.aborted) throw new JevClientError("request_aborted");
    if (timeout.signal.aborted) throw new JevClientError("request_timeout");
    if (error instanceof JevClientError) throw error;
    throw new JevClientError("transport_error");
  } finally {
    if (response?.body) void response.body.cancel().catch(() => undefined);
    clearTimeout(timer);
  }
}
