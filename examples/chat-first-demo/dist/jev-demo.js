/* Browser-only examples of the CRM Jev adoption policy. All model choices are fixtures. */
(function () {
  'use strict';

  const threshold = 0.8;
  const source = 'https://github.com/Jun516/agent-crm-workbench/blob/4e424c8c447d26d86b010594028d0a032c0fe0ef/';
  const evidence = [
    { id: 'SRC-PRICE-003', title: '标准实施包 · 报价政策 v3', excerpt: '含税标准价 12,000 元；超过 5% 的折扣须由商务负责人逐单批准。' },
    { id: 'SRC-DELIVERY-002', title: '实施交付 · 排期政策 v2', excerpt: '提交资料并由交付负责人确认排期后，销售才可以承诺交期。' },
  ];
  const safeDraft = '当前标准价为 12,000 元。10,000 元的报价须由商务负责人批准，10 月 9 日交付须等交付负责人确认。';
  const cases = [
    {
      id: 'high', label: '高置信采纳', draft: safeDraft,
      relevance: ['relevant', 0.94], quality: ['acceptable', 0.8],
    },
    {
      id: 'low', label: '低置信转人工',
      draft: '当前标准价为 12,000 元，预计能保留到本月底。10 月 9 日交付仍要核对排期。',
      relevance: ['relevant', 0.93], quality: ['acceptable', 0.62],
      review: '请运营复核人核对报价有效期。当前价格政策只支持标准价，没有给出保留至月底的依据。',
    },
    {
      id: 'blocked', label: '高置信仍被拦截', draft: safeDraft,
      relevance: ['relevant', 0.96], quality: ['acceptable', 0.95],
      structuredCitations: ['SRC-PRICE-003', 'SRC-APPROVAL-017'],
    },
    {
      id: 'limited', label: '证据权限变化', draft: safeDraft,
      relevance: ['relevant', 0.94], quality: ['acceptable', 0.91],
      withheldId: 'SRC-DELIVERY-002',
      review: '请运营复核人重新核对当前可用的交付政策。旧运行读到过的片段在权限变化后不再外送。',
    },
  ];
  const questions = [
    { key: 'relevance', label: '回答是否切题' },
    { key: 'quality', label: '结论是否有依据且可执行' },
  ];
  const choiceLabels = {
    relevant: '切题', irrelevant: '偏题', acceptable: '可接受',
    unacceptable: '不可接受', insufficient: '证据不足',
  };
  const verdictLabels = {
    pass: ['通过', 'good'], needs_review: ['待人工复核', 'warn'], fail: ['未通过', 'bad'],
  };
  const verdictRank = { pass: 0, needs_review: 1, fail: 2 };
  const observedIds = new Set(evidence.map(item => item.id));

  function escapeHtml(value) {
    const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, character => replacements[character]);
  }

  function evaluate(example) {
    const projectedEvidence = evidence.filter(item => item.id !== example.withheldId);
    const materialLimited = projectedEvidence.length < evidence.length;
    const decisions = questions.map(question => {
      const [choice, confidence] = example[question.key];
      return {
        ...question, choice, confidence,
        adopted: !materialLimited && confidence >= threshold && choice !== 'insufficient',
      };
    });
    const negative = decisions.some(decision => decision.adopted &&
      (decision.choice === 'irrelevant' || decision.choice === 'unacceptable'));
    let choiceVerdict = 'pass';
    if (negative) choiceVerdict = 'fail';
    else if (decisions.some(decision => !decision.adopted)) choiceVerdict = 'needs_review';

    const missingCitation = (example.structuredCitations ?? []).find(id => !observedIds.has(id));
    const gateVerdict = missingCitation ? 'fail' : 'pass';
    const finalVerdict = verdictRank[gateVerdict] > verdictRank[choiceVerdict] ? gateVerdict : choiceVerdict;
    return { projectedEvidence, materialLimited, decisions, choiceVerdict, missingCitation, gateVerdict, finalVerdict };
  }

  function pill(label, tone) {
    return `<span class="gov-pill gov-tone-${tone}">${escapeHtml(label)}</span>`;
  }

  function verdict(value) {
    return pill(...verdictLabels[value]);
  }

  function percentage(value) {
    return `${Math.round(value * 100)}%`;
  }

  function render(scenarioId) {
    const example = cases.find(item => item.id === scenarioId) ?? cases[0];
    const result = evaluate(example);
    const review = example.review ? `<p>${escapeHtml(example.review)}系统保留评测记录，等待处理。</p>` : '';
    const caseButtons = cases.map(item => `<button class="btn gov-scenario-button" type="button" data-governance-scenario="${item.id}" aria-pressed="${item.id === example.id}">${item.label}</button>`).join('');
    const choiceRows = result.decisions.map(decision => `<li>
      <strong>${escapeHtml(decision.label)}</strong>
      <span>${escapeHtml(choiceLabels[decision.choice])} · ${percentage(decision.confidence)}</span>
      ${pill(decision.adopted ? '已采纳' : '未采纳', decision.adopted ? 'good' : 'warn')}
    </li>`).join('');
    const sources = result.projectedEvidence.map(item => `<details class="gov-evidence">
      <summary>${escapeHtml(item.title)} <code>${escapeHtml(item.id)}</code></summary>
      <p>${escapeHtml(item.excerpt)}</p>
    </details>`).join('');
    const citations = example.structuredCitations ? `<p>结构化引用 ${example.structuredCitations.map(id => `<code>${escapeHtml(id)}</code>`).join(' · ')}</p>` : '';
    const missingCitation = result.missingCitation ? `<p><code>${escapeHtml(result.missingCitation)}</code> 没有出现在本次成功的工具观察中。</p><code>structured_result_unobserved_evidence</code>` : '<p>此用例的独立门禁通过。</p>';
    const explanation = {
      pass: `两项判断均达到 ${percentage(threshold)}，证据在当前授权范围内，独立门禁也通过。这里通过的是评测，客户是否接受报价仍需另行确认。`,
      needs_review: result.materialLimited ? '材料受限，暂停自动采纳。' : `有一个判断低于 ${percentage(threshold)}，暂停自动采纳。`,
      fail: 'Jev 的两项语义判断已采纳。独立核查发现无来源引用，最终评测仍然拦截。',
    };

    return `<section class="gov-case" aria-label="Jev 裁决演练">
      <div class="gov-scenarios" role="group" aria-label="选择裁决案例">${caseButtons}</div>
      <article class="gov-card"><h3>星桥商贸 · 跨境客户报价</h3>
        <p>核对客户提出的 10,000 元报价和 10 月 9 日交期。</p>
        <blockquote>${escapeHtml(example.draft)}</blockquote>${citations}
      </article>
      <div class="gov-grid">
        <article class="gov-card">
          <h3>可用于判断的证据</h3>${sources}
          ${result.materialLimited ? `<p>${pill('材料受限', 'warn')} 当前授权校验移除了一个历史片段。</p>` : ''}
        </article>
        <article class="gov-card">
          <h3>Jev 选项裁决</h3>
          <p>逐项采纳门槛为 ${percentage(threshold)}（含）。下列置信度是案例预设值。</p>
          <ul class="gov-choices">${choiceRows}</ul>
        </article>
      </div>
      <article class="gov-card" aria-live="polite">
        <h3>合并评测结果</h3>
        <div class="gov-verdicts">
          <div data-jev-gate="${result.gateVerdict}"><span>独立硬规则</span>${verdict(result.gateVerdict)}</div>
          <div data-jev-choice-result="${result.choiceVerdict}"><span>Jev 裁决</span>${verdict(result.choiceVerdict)}</div>
          <div data-jev-result="${result.finalVerdict}"><span>最终评测</span>${verdict(result.finalVerdict)}</div>
        </div>
        ${missingCitation}<p>${explanation[result.finalVerdict]}</p>${review}
      </article>
      <p class="gov-meta"><a href="${source}lib/ai/evals/run-evaluation.ts" target="_blank" rel="noopener noreferrer">查看结果合并逻辑 ↗</a></p>
    </section>`;
  }

  window.CrmJevDemo = { render };
})();
