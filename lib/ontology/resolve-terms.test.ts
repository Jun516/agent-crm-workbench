import { describe, expect, it } from "vitest";
import { resolveTerms } from "./resolve-terms";

describe("resolveTerms", () => {
  it("resolve termos completos do snapshot publicado com origem e versão", () => {
    const result = resolveTerms("Quais negócios e contato?");
    expect(result.version).toBe("1.0.0");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.candidates.map((x) => x.id)).toEqual(["contact", "opportunity"]);
    expect(result.candidates[0]?.source.path).toBeTruthy();
  });
  it("não casa substrings nem aceita versão desconhecida ou entrada ilimitada", () => {
    expect(resolveTerms("contatosabc").candidates).toEqual([]);
    expect(() => resolveTerms("x", "99.0.0")).toThrow();
    expect(() => resolveTerms("x".repeat(2001))).toThrow();
  });
  it("não promove métricas não certificadas", () => {
    expect(resolveTerms("alto valor").candidates[0]).toMatchObject({ status: "unanswerable" });
  });
});
