(() => {
  const jev = window.CrmJevDemo;
  const rsi = window.CrmRsiDemo;
  const sourceBase = 'https://github.com/Jun516/agent-crm-workbench/blob/4e424c8c447d26d86b010594028d0a032c0fe0ef/';
  let mode = 'jev';
  let jevScenario;
  let rsiState = rsi.createState();
  let opener;

  const dialog = document.createElement('dialog');
  dialog.className = 'gov-dialog';
  dialog.setAttribute('aria-labelledby', 'gov-title');
  dialog.innerHTML = `
    <header class="gov-header">
      <div>
        <p class="gov-kicker">客赢智销 · CRM 交互演示</p>
        <h2 id="gov-title">Jev 裁决与 RSI 自精炼</h2>
      </div>
      <button class="gov-button" type="button" data-governance-action="close" autofocus>返回工作台</button>
    </header>
    <div class="gov-scroll">
      <p class="gov-notice">虚构客户 · 浏览器本地演练。案例中的模型输入输出为示例，页面仅运行演示逻辑。</p>
      <nav class="gov-modes" aria-label="选择演练">
        <button class="gov-button" type="button" data-governance-mode="jev" aria-pressed="true">Jev 评测裁决</button>
        <button class="gov-button" type="button" data-governance-mode="rsi" aria-pressed="false">RSI 只读自精炼</button>
      </nav>
      <section id="gov-panel" aria-label="演练内容"></section>
      <footer class="gov-footer">
        <a id="gov-source" href="${sourceBase}lib/ai/evals/jev-judge.ts" target="_blank" rel="noopener noreferrer">查看 Jev 源码 ↗</a>
        <a href="./LICENSE" target="_blank" rel="noopener noreferrer">基于 Pi Native CRM · MIT 许可</a>
      </footer>
    </div>`;
  document.body.appendChild(dialog);

  const panel = dialog.querySelector('#gov-panel');
  const source = dialog.querySelector('#gov-source');

  function draw() {
    panel.innerHTML = mode === 'jev' ? jev.render(jevScenario) : rsi.render(rsiState);
    const isJev = mode === 'jev';
    source.href = sourceBase + (isJev ? 'lib/ai/evals/jev-judge.ts' : 'lib/ai/agents/refinement.ts');
    source.textContent = isJev ? '查看 Jev 源码 ↗' : '查看 RSI 源码 ↗';
    for (const button of dialog.querySelectorAll('[data-governance-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.governanceMode === mode));
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-governance]');
    if (!button || dialog.open) return;
    opener = button;
    draw();
    dialog.showModal();
  });

  dialog.addEventListener('close', () => {
    (opener?.isConnected ? opener : document.querySelector('[data-open-governance]'))?.focus();
  });

  dialog.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { governanceAction, governanceMode, governanceScenario, rsiScenario } = button.dataset;
    if (governanceAction === 'close') {
      dialog.close();
      return;
    }
    if (governanceMode) {
      mode = governanceMode;
      draw();
      return;
    }
    if (governanceScenario) {
      jevScenario = governanceScenario;
      draw();
      [...panel.querySelectorAll('[data-governance-scenario]')]
        .find(item => item.dataset.governanceScenario === jevScenario)?.focus();
      return;
    }
    if (['rsi-next', 'rsi-reset', 'rsi-scenario'].includes(governanceAction)) {
      rsiState = governanceAction === 'rsi-next'
        ? rsi.advance(rsiState)
        : rsi.createState(rsiScenario ?? rsiState.scenarioId);
      draw();
      const progress = panel.querySelector('[data-rsi-progress]');
      if (governanceAction === 'rsi-next' && progress) {
        progress.focus();
      } else {
        panel.querySelector('[data-governance-action="rsi-next"]')?.focus();
      }
    }
  });

  const previousRender = render;
  render = function () {
    previousRender();
    const header = document.querySelector('.agent-header-actions');
    if (!header) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn gov-launch';
    button.dataset.openGovernance = '';
    button.setAttribute('aria-haspopup', 'dialog');
    button.textContent = 'Jev / RSI 演练';
    header.prepend(button);
  };

  render();
})();
