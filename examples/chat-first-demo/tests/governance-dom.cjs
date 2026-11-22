const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const html = readFileSync('dist/index.html', 'utf8').replace(
  /<script src="([^"]+)"><\/script>/g,
  (_, file) => `<script>${readFileSync(`dist/${file}`, 'utf8').replace(/<\/script>/g, '<\\/script>')}</script>`,
);
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://example.test/crm/#/app/ai/workbench',
  virtualConsole,
  beforeParse(window) {
    window.structuredClone = structuredClone;
    window.scrollTo = () => {};
    const dialog = window.HTMLDialogElement.prototype;
    // jsdom does not implement native dialog behavior. Browser smoke covers focus and Escape.
    if (!dialog.showModal) dialog.showModal = function () { this.open = true; };
    if (!dialog.close) dialog.close = function () {
      this.open = false;
      this.dispatchEvent(new window.Event('close'));
    };
  },
});

const { document } = dom.window;
function get(selector) {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  return element;
}

const dialog = get('.gov-dialog');
assert.equal(dialog.open, false);
get('[data-open-governance]').click();
assert.equal(dialog.open, true);
assert.equal(get('[data-jev-result]').dataset.jevResult, 'pass');

get('[data-governance-scenario="low"]').click();
assert.equal(get('[data-jev-result]').dataset.jevResult, 'needs_review');
assert.match(get('#gov-panel').textContent, /请运营复核人/);

get('[data-governance-scenario="blocked"]').click();
assert.equal(get('[data-jev-choice-result]').dataset.jevChoiceResult, 'pass');
assert.equal(get('[data-jev-gate]').dataset.jevGate, 'fail');
assert.equal(get('[data-jev-result]').dataset.jevResult, 'fail');

get('[data-governance-scenario="limited"]').click();
assert.equal(get('[data-jev-result]').dataset.jevResult, 'needs_review');
assert.doesNotMatch(get('#gov-panel').textContent, /SRC-DELIVERY-002/);

const next = '[data-governance-action="rsi-next"]';
get('[data-governance-mode="rsi"]').click();
assert.match(get('#gov-source').href, /agents\/refinement\.ts$/);
for (let i = 0; i < 4; i++) get(next).click();
assert.equal(document.querySelectorAll('[data-rsi-candidate]').length, 4);
assert.match(get('[data-rsi-stop="round_limit"]').textContent, /保留候选 2A/);
assert.equal(document.querySelector(next), null);

get('[data-rsi-scenario="budget"]').click();
for (let i = 0; i < 3; i++) get(next).click();
assert.equal(document.querySelectorAll('[data-rsi-candidate]').length, 2);
assert.match(get('[data-rsi-stop="budget_exhausted"]').textContent, /部分结果/);
get('[data-governance-action="rsi-reset"]').click();
assert.equal(document.querySelectorAll('[data-rsi-candidate]').length, 0);
assert.equal(get('[data-rsi-scenario="budget"]').getAttribute('aria-pressed'), 'true');

get('[data-governance-action="close"]').click();
assert.equal(dialog.open, false);
assert.equal(errors.length, 0, errors.join('\n'));
dom.window.close();
process.stdout.write('PASS: static CRM governance navigation, all Jev outcomes, both RSI paths and reset.\n');
