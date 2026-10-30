"use client";

import { useState } from "react";
import type { JevChoiceReview } from "@/lib/ai/evals/contracts";

export function JevEvaluationControls(props: {
  runId: string;
  busy: boolean;
  terminal: boolean;
  configured?: boolean;
  review?: {
    status?: string;
    verdict?: string;
    choiceReview?: JevChoiceReview;
    requestedModel?: string;
    policyFingerprint?: string;
  } | null;
  onRun: () => void;
}) {
  const [consented, setConsented] = useState(false);
  const review = props.review?.choiceReview;
  return (
    <div className="mt-3 rounded-md border p-2" aria-label="Jev 选择式评测">
      <p className="font-medium">Jev 选择式评测</p>
      <p className="mt-1 text-muted-foreground">
        显式运行才会向 TypeSafe 发送脱敏任务、最终答案和必要知识片段，可能产生服务费用。
        不发送隐藏推理或完整客户档案；低置信度默认人工复核，不自动再次请求。
      </p>
      {props.configured === false && (
        <p className="mt-1 text-muted-foreground">
          当前未配置 Jev，请联系安装管理员；原评测仍可使用。
        </p>
      )}
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          aria-label="允许将本次脱敏评测材料发送到 TypeSafe"
        />
        <span>允许将本次脱敏评测材料发送到 TypeSafe</span>
      </label>
      <button
        type="button"
        onClick={props.onRun}
        disabled={props.busy || !props.terminal || !consented || props.configured === false}
        className="mt-2 rounded-md border px-2 py-1 font-medium disabled:opacity-50"
      >
        运行 Jev 评测（外部服务）
      </button>
      {props.review?.status === "failed" && (
        <p className="mt-2 text-muted-foreground">
          Jev 评测未能完成，已保留确定性门禁，请人工复核；未自动重试。 请求模型：
          {props.review.requestedModel}。
        </p>
      )}
      {review && (
        <div className="mt-2 rounded-md bg-muted p-2 text-muted-foreground">
          <p>
            Jev：{props.review?.verdict} · 模型 {review.model}
          </p>
          {review.decisions.map((decision) => (
            <p key={decision.criterion}>
              {decision.criterion === "relevance" ? "任务相关性" : "输出质量"}：{decision.choice}
              {` · 置信度 ${(decision.confidence * 100).toFixed(1)}% · ${decision.adopted ? "达到策略阈值" : "待人工复核"}`}
            </p>
          ))}
          <p>
            阈值 {(review.confidenceThreshold * 100).toFixed(0)}% 是演示决策策略，未经准确率校准。
          </p>
          {review.escalation === "human_review" && (
            <p>下一步：人工核对缺失材料与判断；系统没有自动重试。</p>
          )}
          {review.materialCoverage === "limited" && <p>材料经过裁剪或省略，不代表完整事实验证。</p>}
          <details className="mt-1">
            <summary>模型与规则回执</summary>
            <p>请求模型：{review.requestedModel}</p>
            <p className="break-all">规则指纹：{review.policyFingerprint}</p>
            <p className="break-all">请求指纹：{review.requestFingerprint}</p>
            <p>本次展示已保存的评测结果，不会因展开详情重新请求。</p>
          </details>
        </div>
      )}
    </div>
  );
}
