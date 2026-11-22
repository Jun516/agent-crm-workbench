(function () {
  "use strict";

  const sources = {
    lead: {
      label: "CRM 商机 · LEAD-024",
      detail: "状态为跟进中，优惠报价等待商务审批。",
    },
    thread: {
      label: "客户会话 · THR-018",
      detail: "客户提出 10,000 元预算，尚未接受报价。",
    },
    policy: {
      label: "报价政策 · PRICE-v3",
      detail: "标准实施包 12,000 元。优惠报价须经商务审批。",
    },
  };

  const rounds = [
    [
      {
        id: "1A",
        objective: "从商机出发",
        answer: "商机还在跟进。报价政策读取失败，暂无法解释价格差异。",
        evidence: ["lead"],
        fields: ["lead.status"],
        missingPolicy: true,
      },
      {
        id: "1B",
        objective: "核对客户表态",
        answer: "客户提出 10,000 元预算，尚未接受报价。建议等待审批后再确认价格。",
        evidence: ["thread"],
        fields: ["thread.quoteAccepted"],
      },
    ],
    [
      {
        id: "2A",
        objective: "补查政策并核对记录",
        answer: "商机处于跟进中。客户提出的 10,000 元属于预算请求，标准价是 12,000 元。待审批后再确认能否提供优惠。",
        evidence: ["lead", "thread", "policy"],
        fields: ["lead.status", "thread.quoteAccepted", "policy.standardPrice"],
      },
      {
        id: "2B",
        objective: "复核报价与授权",
        answer: "标准价是 12,000 元。商机记录显示优惠未获批准，建议先走商务审批。",
        evidence: ["lead", "policy"],
        fields: ["lead.discountApproval", "policy.standardPrice"],
      },
    ],
  ];

  const scenarios = {
    standard: { label: "预算充足", totalTurns: 14 },
    budget: { label: "预算不足", totalTurns: 8 },
  };
  const lessonText = {
    separate_facts_and_inference: "把工具读到的事实、分析推断和未知项分开写。",
    verify_missing_material: "先补查缺失材料。读取失败时保留未知。",
  };
  const turnsPerCandidate = 2;

  function createState(scenarioId = "standard") {
    const scenario = Object.hasOwn(scenarios, scenarioId) ? scenarioId : "standard";
    const totalTurns = scenarios[scenario].totalTurns;
    return {
      scenarioId: scenario,
      totalTurns,
      availableTurns: Math.min(Math.floor(totalTurns * 0.65), totalTurns - 2),
      usedTurns: 0,
      roundIndex: 0,
      results: [],
      winner: null,
      lessons: [],
      stopReason: null,
    };
  }

  function evaluate(candidate, appliedLessons) {
    const issues = candidate.missingPolicy ? ["material_missing"] : [];
    return {
      ...candidate,
      issues,
      appliedLessons,
      coverage: issues.length ? 0 : 40 + candidate.evidence.length * 5 + candidate.fields.length * 3,
    };
  }

  function advance(state) {
    if (state.stopReason) return state;
    if (state.availableTurns - state.usedTurns < turnsPerCandidate) {
      return { ...state, stopReason: "budget_exhausted" };
    }

    const round = rounds[state.roundIndex];
    const position = state.results.length % round.length;
    const result = evaluate(round[position], state.lessons);
    const results = [...state.results, result];
    const usedTurns = state.usedTurns + turnsPerCandidate;
    if (position + 1 < round.length) {
      return { ...state, results, usedTurns };
    }

    const roundResults = results.slice(-round.length);
    let winner = state.winner;
    for (const candidate of roundResults) {
      if (!candidate.issues.length && (!winner || candidate.coverage > winner.coverage)) {
        winner = candidate;
      }
    }
    const lessons = new Set(state.lessons);
    for (const candidate of roundResults) {
      if (candidate.id === winner?.id) continue;
      lessons.add("separate_facts_and_inference");
      if (candidate.issues.includes("material_missing")) lessons.add("verify_missing_material");
    }
    const roundIndex = state.roundIndex + 1;
    return {
      ...state,
      results,
      usedTurns,
      winner,
      lessons: [...lessons],
      roundIndex,
      stopReason: roundIndex === rounds.length ? "round_limit" : null,
    };
  }

  function renderCandidate(candidate, state) {
    const rejected = candidate.issues.length > 0;
    const latest = !state.stopReason && state.results.at(-1)?.id === candidate.id;
    const detail = rejected
      ? "材料缺失，淘汰。保留读取失败这个事实。"
      : `通过结构检查 · 证据覆盖分 ${candidate.coverage}`;
    return `<article class="gov-card" data-rsi-candidate="${candidate.id}">
      <h4${latest ? ' tabindex="-1" data-rsi-progress' : ""}>候选 ${candidate.id} · ${candidate.objective}</h4>
      ${candidate.appliedLessons.includes("verify_missing_material")
        ? '<p class="gov-muted">带着上一轮的补查提示重新读取报价政策。</p>'
        : ""}
      <p>${candidate.answer}</p>
      <p class="gov-status">${detail}${state.winner?.id === candidate.id ? " · 当前保留" : ""}</p>
      <details>
        <summary>查看只读证据${rejected ? "和缺失材料" : ""}</summary>
        <ul>${candidate.evidence.map((id) =>
          `<li><strong>${sources[id].label}</strong> · ${sources[id].detail}</li>`,
        ).join("")}${rejected ? "<li><strong>报价政策</strong> · 演示该次读取失败</li>" : ""}</ul>
        ${rejected ? "<p><code>material_missing</code></p>" : ""}
      </details>
    </article>`;
  }

  function renderProgress(state) {
    if (state.stopReason === "budget_exhausted") {
      return `<div class="gov-result" data-rsi-stop="budget_exhausted">
        <h4 tabindex="-1" data-rsi-progress>预算不足 · 停止继续取证</h4>
        <p>可用的模型轮次少于开新候选所需的 2 次。父 Agent 收到候选 ${state.winner.id} 作为部分结果，报价政策仍需核对。</p>
        <p class="gov-muted"><code>budget_exhausted</code> · <code>partial</code></p>
      </div>`;
    }
    if (state.stopReason === "round_limit") {
      return `<div class="gov-result" data-rsi-stop="round_limit">
        <h4 tabindex="-1" data-rsi-progress>达到 2 轮上限 · 保留候选 ${state.winner.id}</h4>
        <p>父 Agent 获得覆盖商机、客户会话和报价政策的建议，可以用于后续分析。优惠仍等待商务审批。</p>
        <p class="gov-muted"><code>round_limit</code> · <code>complete</code></p>
      </div>`;
    }
    if (state.roundIndex === 1) {
      const message = state.availableTurns - state.usedTurns < turnsPerCandidate
        ? "系统下一步会先检查剩余预算。"
        : "第二轮带着候选草稿和补查提示重新取证。";
      return `<p class="gov-result">第 1 轮暂留候选 ${state.winner.id}。${message}</p>`;
    }
    return "";
  }

  function render(state) {
    const nextLabel = state.availableTurns - state.usedTurns < turnsPerCandidate
      ? "检查剩余预算"
      : `核验候选 ${rounds[state.roundIndex]?.[state.results.length % 2].id || ""}`;
    return `<section class="gov-panel" aria-label="RSI 只读自精炼">
      <h3${state.results.length ? "" : ' tabindex="-1" data-rsi-progress'}>RSI 有界只读自精炼</h3>
      <p>星桥商贸提出 10,000 元预算。逐步核验候选报告，决定哪些结论可以交给父 Agent。</p>
      <p class="gov-muted">浏览器规则演练 · 虚构资料 · 模型调用与 CRM 写入均为 0</p>
      <div class="gov-actions" role="group" aria-label="演练预算">
        ${Object.entries(scenarios).map(([id, scenario]) =>
          `<button type="button" class="gov-button" aria-pressed="${id === state.scenarioId}" data-governance-action="rsi-scenario" data-rsi-scenario="${id}">${scenario.label}</button>`,
        ).join("")}
      </div>
      <p><strong>演练预算</strong> · 候选已用 ${state.usedTurns} / ${state.availableTurns} 次模型轮次，父 Agent 预留 ${state.totalTurns - state.availableTurns} 次。最多 2 轮核验，每轮 2 个候选。</p>
      <p class="gov-muted">完整运行会另查 token 和费用预算。证据覆盖分用于比较候选，准确率须另行验证。</p>
      <div class="gov-actions">
        ${state.stopReason ? "" : `<button type="button" class="gov-button gov-button-primary" data-governance-action="rsi-next">${nextLabel}</button>`}
        <button type="button" class="gov-button" data-governance-action="rsi-reset">重置演练</button>
      </div>
      <div class="gov-steps" aria-label="候选核验记录">
        ${state.results.map((candidate) => renderCandidate(candidate, state)).join("")}
      </div>
      ${renderProgress(state)}
      ${state.lessons.length ? `<div class="gov-card">
        <h4>留给后续核验的经验提示</h4>
        <ul>${state.lessons.map((code) => `<li>${lessonText[code]}</li>`).join("")}</ul>
        <p class="gov-muted">完整 CRM 保存预设提示代码，在同一 Agent 版本的有效期内复用。当前证据和政策优先。</p>
      </div>` : ""}
    </section>`;
  }

  window.CrmRsiDemo = { createState, advance, render };
})();
