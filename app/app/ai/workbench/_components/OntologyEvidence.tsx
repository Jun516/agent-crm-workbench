"use client";

type Entry = { id: string; payload: Record<string, unknown> };
const statuses: Record<string, string> = {
  full: "完整",
  partial: "部分",
  unanswerable: "无法回答",
  supported: "可查询",
  unsupported: "缺少定义",
};
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const show = (value: unknown): string =>
  Array.isArray(value)
    ? value.join("、")
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "未记录";

export function OntologyEvidence({ entries }: { entries: Entry[] }) {
  if (!entries.length) return null;
  return (
    <details className="rounded-lg border p-3 text-sm" aria-label="语义依据">
      <summary className="cursor-pointer font-semibold">语义依据、范围与查询回执</summary>
      <div className="mt-3 space-y-3">
        {entries.map(({ id, payload }) => {
          const receipt = asObject(payload.receipt);
          return (
            <div key={id} className="space-y-1 rounded border p-3 break-words">
              <p>
                状态：{statuses[String(payload.status)] ?? "概念发现"}
                {payload.degraded ? "（降级）" : ""}
              </p>
              {asObject(payload.semantics)?.type === "action" && <p>动作描述：{show(asObject(payload.semantics)?.capability)}。描述不授予执行权。</p>}
              {asObject(payload.semantics)?.type === "outcome" && <p>验收描述：{show(asObject(payload.semantics)?.checks && JSON.stringify(asObject(payload.semantics)?.checks))}。客户入站不代表同意，自由文本目标仍需核实。</p>}
              {payload.assumption === true && <p>假设查询：条件未经业务认证。</p>}
              {Array.isArray(payload.missing) && <p>数据缺口：{payload.missing.join("；")}</p>}
              {receipt && (
                <dl className="space-y-1 text-muted-foreground">
                  <div>
                    <dt className="inline font-medium">定义版本：</dt>
                    <dd className="inline">{show(receipt.ontologyVersion)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">查询范围：</dt>
                    <dd className="inline">
                      {show(receipt.scope)}；{show(receipt.visibility)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">授权漏斗：</dt>
                    <dd className="inline">
                      {receipt.effectivePipelineIds === null
                        ? "全部可见漏斗"
                        : show(receipt.effectivePipelineIds) || "无"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">关系：</dt>
                    <dd className="inline">{show(receipt.relations) || "无"}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">来源：</dt>
                    <dd className="inline">{show(receipt.sources)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">查询回执：</dt>
                    <dd className="inline">
                      {show(receipt.template)}；{show(receipt.rowCount)} 条，最多{" "}
                      {show(receipt.rowLimit)} 条
                    </dd>
                  </div>
                  {receipt.caveat != null && (
                    <div>
                      <dt className="inline font-medium">数据缺口：</dt>
                      <dd className="inline">{show(receipt.caveat)}</dd>
                    </div>
                  )}
                  {receipt.criteria != null && (
                    <div>
                      <dt className="inline font-medium">假设条件：</dt>
                      <dd className="inline">{JSON.stringify(receipt.criteria)}</dd>
                    </div>
                  )}
                </dl>
              )}
              {(payload.terms != null || receipt) && (
                <details>
                  <summary className="cursor-pointer text-xs">查看完整回执和概念</summary>
                  <pre className="text-xs whitespace-pre-wrap">
                    {JSON.stringify({ terms: payload.terms, receipt }, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
