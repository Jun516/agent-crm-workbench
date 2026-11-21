/**
 * Offline component/browser QA, not authenticated backend E2E.
 * Run: node scripts/qa-workbench-motion.mjs
 * Build-only check: node scripts/qa-workbench-motion.mjs --build-only
 * Manual offline preview: node scripts/qa-workbench-motion.mjs --serve
 * Uses Playwright's installed Chromium unless CHROMIUM_PATH overrides it.
 * Uses the real Workbench, Sheet, MotionDisclosure and globals.css. Only API
 * responses and the containing viewport are fixtures; no provider is activated.
 * Temporary files and evidence stay in ignored .prova/motion/.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".prova/motion");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "index.html"),
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;; script-src &apos;self&apos; &apos;unsafe-inline&apos;; style-src &apos;self&apos; &apos;unsafe-inline&apos;; img-src &apos;self&apos; data:; font-src &apos;self&apos;; connect-src &apos;self&apos;"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixtures.js"></script><script type="module" src="/entry.tsx"></script></body></html>',
);
await writeFile(
  path.join(out, "entry.tsx"),
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentCrmWorkbench } from '@/app/app/ai/workbench/_components/AgentCrmWorkbench';
import { MotionDisclosure } from '@/components/ui/motion-disclosure';
import { CustomerMemoryPanel } from '@/components/ai/CustomerMemoryPanel';
import '@/app/globals.css';
const agents = [{ id: 'qa-agent', name: '情报员', description: '读取 CRM 证据，提供清晰的下一步建议', builtinKey: 'crm_intelligence', scenarios: [{ title: '找出停滞商机', task: '请检查停滞商机', harnessFocus: 'CRM 证据' }] }];
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100dvh', padding: 16, minWidth: 0, overflow: 'hidden' }}>
    {surface === 'disclosure' ? <div style={{ maxWidth: 640, margin: '40px auto' }}>
      <MotionDisclosure title="核对证据" className="rounded-lg border p-3">
        <p>已确认的 CRM 证据。展开只影响显示，不改变运行状态。</p>
        <a href="#fixture-source">查看测试来源</a><input aria-label="测试证据备注" />
      </MotionDisclosure><button type="button">后续操作</button>
    </div> : surface === 'memory' ? <CustomerMemoryPanel contactId="qa-contact" readOnly /> :
    <AgentCrmWorkbench agents={agents} modelConfigured canCopy />}
  </main>
);
`,
);

// Runs in the browser before React. This transport never reaches an API server.
function installFixtures() {
  // Vite serves this fixture outside Next.js. Give next/link its optional
  // build-time flags without reading the host process environment.
  globalThis.process ??= { env: {} };
  const records = new Map();
  const streams = new Map();
  const requests = [];
  const animationStarts = [];
  let nextStatus = "completed";
  let serial = 0;
  let currentId;
  let holdReads = false;
  let releaseReads;
  let heldReads;
  const evaluation = {
    verdict: "pass",
    score: 92,
    profileKey: "qa-fixture",
    dimensions: [
      {
        key: "grounding",
        label: "证据关联",
        verdict: "pass",
        score: 92,
        findings: [{ code: "fixture_evidence", message: "已关联 CRM 中的明确证据。" }],
      },
    ],
    summary: {
      toolCalls: 1,
      toolErrors: 0,
      knowledgeSearches: 1,
      groundedEvidenceItems: 1,
      specialistRuns: 0,
      specialistFailures: 0,
      structuredClaims: 1,
    },
    semanticJudge: { status: "not_run" },
  };
  const detail = (id, task, status, finalText) => ({
    id,
    task,
    status,
    agent_id: "qa-agent",
    mode: "inspect",
    final_text: finalText,
    error_code: status === "failed" ? "fixture_failure" : null,
    created_at: "2026-10-01T08:00:00Z",
    events: [
      {
        id: id + "-e1",
        sequence: 1,
        event_type: status === "running" ? "context_loaded" : "run_" + status,
        payload: {},
        created_at: "2026-10-01T08:00:00Z",
      },
    ],
    proposals: [],
    specialists: [],
    observed_evidence: [
      {
        id: "evidence-1",
        namespace: "crm",
        title: "已确认的客户偏好",
        excerpt: "客户希望下周收到下一步建议，具体方案仍需确认。",
        source_id: "fixture-source",
        revision: "1",
        revision_kind: "memory_snapshot",
        index_status: "current",
        uri: "#fixture-source",
      },
    ],
  });
  records.set(
    "history",
    detail(
      "history",
      "历史记录：已核实客户需求",
      "completed",
      "历史结果：客户希望下周收到下一步建议。",
    ),
  );
  records.set(
    "history-long",
    detail(
      "history-long",
      "历史记录：长篇证据",
      "completed",
      Array.from(
        { length: 60 },
        (_, i) => `历史证据 ${i + 1}：保持操作员阅读位置，避免新事件打断阅读。`,
      ).join("\n"),
    ),
  );
  const json = (data) =>
    new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  window.__motionFixture = {
    requests,
    animationStarts,
    next(status) {
      nextStatus = status;
    },
    current() {
      return currentId;
    },
    clearAnimations() {
      animationStarts.length = 0;
    },
    streamReady() {
      return streams.has(currentId);
    },
    emit(status, options = {}) {
      const record = records.get(currentId);
      const event = {
        id: currentId + "-e" + (record.events.length + 1),
        sequence: record.events.length + 1,
        event_type: status === "running" ? "context_loaded" : "run_" + status,
        payload: status === "failed" ? { code: "fixture_failure" } : {},
        created_at: "2026-10-01T08:01:00Z",
      };
      record.status = status;
      record.error_code = status === "failed" ? "fixture_failure" : null;
      record.final_text = options.text ?? `合成结果：${status}`;
      record.events.push(event);
      holdReads = Boolean(options.holdReads);
      if (holdReads)
        heldReads = new Promise((resolve) => {
          releaseReads = resolve;
        });
      const controller = streams.get(currentId);
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"));
      controller.close();
      streams.delete(currentId);
      return performance.now();
    },
    release() {
      holdReads = false;
      releaseReads?.();
    },
    extend(text) {
      records.get(currentId).final_text = text;
    },
  };
  document.addEventListener("animationstart", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.workbenchMessage) return;
    const style = getComputedStyle(target);
    const animation = target.getAnimations()[0];
    animationStarts.push({
      kind: target.dataset.workbenchMessage,
      text: target.textContent,
      name: event.animationName,
      duration: style.animationDuration,
      easing: style.animationTimingFunction,
      keyframes: animation?.effect?.getKeyframes(),
    });
  });
  window.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : (input.url ?? String(input)),
      location.origin,
    );
    if (url.origin !== location.origin) throw new Error("External fetch denied: " + url.origin);
    const pathname = url.pathname;
    requests.push({ path: pathname, method: init.method ?? "GET" });
    if (pathname === "/api/v1/ai/workbench/runs") {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        currentId = "submitted-" + ++serial;
        records.set(
          currentId,
          detail(
            currentId,
            body.task,
            nextStatus,
            nextStatus === "completed"
              ? `合成结果：${body.task}。建议核对客户需求并安排下一步跟进。`
              : null,
          ),
        );
        return json({ run_id: currentId });
      }
      return json([...records.values()].reverse());
    }
    if (pathname === "/api/v1/ai/workbench/objects") return json([]);
    if (pathname === "/api/v1/ai/customer-memory")
      return json([
        {
          id: "memory-1",
          category: "preference",
          body: "客户希望通过文字接收明确的下一步建议。",
          sync_state: "local",
          write_outcome: "saved",
          deleted_at: null,
          remote_deleted_at: null,
        },
      ]);
    const match = /^\/api\/v1\/ai\/workbench\/runs\/([^/]+)(.*)$/.exec(pathname);
    if (match) {
      const record = records.get(match[1]);
      if (!record) throw new Error("Unknown fixture run: " + match[1]);
      if (match[2] === "/evaluation") return json(evaluation);
      if (match[2] === "/events")
        return new Response(
          new ReadableStream({
            start(controller) {
              streams.set(match[1], controller);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (match[2] === "/cancel") {
        record.status = "cancelled";
        record.final_text = "合成结果：运行已取消";
        const controller = streams.get(match[1]);
        if (controller) {
          const event = {
            id: match[1] + "-cancelled",
            sequence: record.events.length + 1,
            event_type: "run_cancelled",
            payload: {},
            created_at: "2026-10-01T08:02:00Z",
          };
          record.events.push(event);
          controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"));
          controller.close();
          streams.delete(match[1]);
        }
        return json({ status: "cancelled" });
      }
      if (!match[2]) {
        if (holdReads) await heldReads;
        return json(record);
      }
    }
    throw new Error("Unexpected fixture API request: " + pathname);
  };
}

await writeFile(path.join(out, "fixtures.js"), "(" + installFixtures.toString() + ")();");

if (process.argv.includes("--build-only")) {
  await build({
    configFile: false,
    envDir: false,
    root: out,
    resolve: { alias: { "@": root } },
    css: { postcss: { plugins: [tailwindcss()] } },
    build: { outDir: path.join(out, "dist"), emptyOutDir: true },
  });
  process.stdout.write(JSON.stringify({ build: "passed", browserCasesExecuted: 0 }) + "\n");
  process.exit(0);
}

const report = {
  scope:
    "Offline real-component browser QA; synthetic transport; no authentication, Supabase, provider or customer sends",
  browser: "",
  cases: [],
  screenshots: [],
  consoleErrors: [],
  externalRequests: [],
};
const server = await createServer({
  configFile: false,
  root: out,
  envDir: false,
  resolve: { alias: { "@": root } },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] }, hmr: false },
  logLevel: "error",
});
let browser;
async function check(name, run) {
  const started = Date.now();
  try {
    const measurements = await run();
    report.cases.push({ name, passed: true, milliseconds: Date.now() - started, measurements });
    process.stderr.write("PASS " + name + "\n");
  } catch (error) {
    report.cases.push({
      name,
      passed: false,
      milliseconds: Date.now() - started,
      error: String(error.stack ?? error),
    });
    process.stderr.write("FAIL " + name + ": " + error.message + "\n");
  }
}
async function screenshot(page, name) {
  const destination = path.join(out, name + ".png");
  await page.screenshot({ path: destination, fullPage: true });
  report.screenshots.push(destination);
}
async function animations(page) {
  return page.evaluate(() => window.__motionFixture.animationStarts);
}
async function send(page, text) {
  await page.getByLabel("给 Agent 的任务").fill(text);
  await page.getByRole("button", { name: "运行 Agent", exact: true }).click();
}
async function settled(page) {
  await expect(page.getByLabel("给 Agent 的任务")).toBeEnabled();
  await expect(page.locator("[data-workbench-message][data-entering]")).toHaveCount(0);
}
async function styles(locator) {
  return locator.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      animationName: css.animationName,
      animationDuration: css.animationDuration,
      transitionDuration: css.transitionDuration,
      transitionProperty: css.transitionProperty,
      transform: css.transform,
      opacity: css.opacity,
      color: css.color,
      background: css.backgroundColor,
    };
  });
}
async function bounds(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const r = element?.getBoundingClientRect();
      return r
        ? {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            bottom: r.bottom,
            right: r.right,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }
        : null;
    };
    return {
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      workbench: rect("[data-agent-workbench]"),
      composer: rect('form[aria-label="发送 Agent 任务"]'),
      messages: rect('[aria-label="Agent 对话"]'),
      dialog: rect('[role="dialog"]'),
    };
  });
}
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  if (process.argv.includes("--serve")) {
    process.stdout.write("Offline component fixture available at " + origin + "\n");
    await new Promise(() => {});
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox"],
  });
  report.browser = browser.version();
  const makePage = async (viewport, reducedMotion = "no-preference", suffix = "") => {
    const context = await browser.newContext({
      viewport,
      reducedMotion,
      locale: "zh-CN",
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      report.externalRequests.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.consoleErrors.push(String(error.stack ?? error)));
    page.on("console", (msg) => {
      if (msg.type() === "error") report.consoleErrors.push(msg.text());
    });
    await page.goto(origin + "/" + suffix);
    await expect(
      page.locator("[data-agent-workbench], button[aria-expanded]").first(),
    ).toBeVisible();
    return page;
  };

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const label = viewport.width > 600 ? "desktop" : "mobile";
    const page = await makePage(viewport);
    await check(label + ": actual Workbench fits viewport", async () => {
      const measured = await bounds(page);
      assert(measured.documentWidth <= viewport.width);
      assert(measured.composer.bottom <= viewport.height);
      assert(measured.messages.height > 150);
      await screenshot(page, label + "-initial");
      return measured;
    });
    await check(label + ": composer 100ms feedback", async () => {
      await page.getByLabel("给 Agent 的任务").fill("核对客户偏好");
      const button = page.getByRole("button", { name: "运行 Agent", exact: true });
      const idle = await styles(button);
      assert.equal(idle.transitionDuration, "0.1s, 0.1s");
      const r = await button.boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await expect
        .poll(async () => (await styles(button)).transform)
        .toBe("matrix(0.97, 0, 0, 0.97, 0, 0)");
      const pressed = await styles(button);
      await page.mouse.move(1, 1);
      await page.mouse.up();
      return { idle, pressed };
    });
    await check(label + ": each new message enters once at 160ms / 5px", async () => {
      await page.evaluate(() => window.__motionFixture.clearAnimations());
      await send(page, "核对客户偏好");
      await settled(page);
      const first = await animations(page);
      assert.deepEqual(first.map((item) => item.kind).sort(), ["result", "task"]);
      for (const item of first) {
        assert.equal(item.duration, "0.16s");
        assert.equal(item.easing, "ease-out");
        assert.equal(item.keyframes[0].transform, "translateY(5px)");
        assert.equal(item.keyframes[0].opacity, "0");
      }
      await page.getByRole("button", { name: "任务设置", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await screenshot(page, label + "-settings");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByLabel("给 Agent 的任务")).toBeFocused();
      assert.equal((await animations(page)).length, 2, "Sheet rerender must not replay messages");
      await send(page, "确认下一步安排");
      await settled(page);
      assert.equal(
        (await animations(page)).length,
        4,
        "Second submission animates only two new messages",
      );
      await screenshot(page, label + "-conversation");
      return { animationStarts: await animations(page), bounds: await bounds(page) };
    });
    await check(label + ": real Sheet and disclosure keyboard behavior", async () => {
      await page.getByRole("button", { name: /^运行详情/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const toggle = dialog.getByRole("button", { name: "已确认的客户偏好", exact: true });
      await toggle.scrollIntoViewIfNeeded();
      const id = await toggle.getAttribute("aria-controls");
      const panel = page.locator(`[id=${JSON.stringify(id)}]`);
      const link = panel.getByRole("link", { name: "查看来源", includeHidden: true });
      await toggle.focus();
      assert.equal(await panel.evaluate((element) => element.inert), true);
      await link.evaluate((element) => element.focus());
      await expect(toggle).toBeFocused();
      const collapsed = await panel.boundingBox();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(link).toBeVisible();
      assert.equal((await styles(panel)).transitionDuration, "0.19s");
      await expect.poll(async () => (await panel.boundingBox()).height).toBeGreaterThan(50);
      await toggle.press("Tab");
      await expect(link).toBeFocused();
      await toggle.focus();
      await toggle.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      assert.equal(await panel.evaluate((element) => element.inert), true);
      await toggle.press("Tab");
      await expect(link).not.toBeFocused();
      await expect.poll(async () => (await panel.boundingBox()).height).toBe(0);
      await toggle.focus();
      await toggle.press("Enter");
      await expect(link).toBeVisible();
      // Wait for the actual CSS transition, not a DOM-only visibility assertion.
      await panel.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      await screenshot(page, label + "-details-expanded");
      const measured = await bounds(page);
      assert(measured.dialog.right <= viewport.width + 1);
      assert(measured.dialog.bottom <= viewport.height + 1);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      return { collapsed, expandedDuration: "190ms", bounds: measured };
    });
    await check(label + ": history selection never replays entry", async () => {
      await page.evaluate(() => window.__motionFixture.clearAnimations());
      await page.getByRole("button", { name: /^运行详情/ }).click();
      await page.getByRole("button", { name: /历史记录：已核实客户需求/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('[data-workbench-message="result"]')).toHaveText(
        "历史结果：客户希望下周收到下一步建议。",
      );
      assert.equal((await animations(page)).length, 0);
      assert.equal(
        (await styles(page.locator('[data-workbench-message="result"]'))).animationName,
        "none",
      );
      return { animationStarts: await animations(page) };
    });
    await check(label + ": streamed failure status is immediate; no failure entry", async () => {
      await page.evaluate(() => {
        window.__motionFixture.next("running");
        window.__motionFixture.clearAnimations();
      });
      await send(page, "模拟失败状态");
      await expect.poll(() => page.evaluate(() => window.__motionFixture.streamReady())).toBe(true);
      await expect(page.locator('[data-run-status="running"]')).toBeVisible();
      await page.evaluate(() => window.__motionFixture.emit("failed", { holdReads: true }));
      // Final detail is deliberately blocked: only the canonical event can update this status.
      await expect(page.locator('[data-run-status="failed"]')).toBeVisible();
      await expect(page.getByText("运行错误：fixture_failure", { exact: true })).toBeVisible();
      const failed = await styles(page.locator('[data-run-status="failed"]'));
      assert.equal(failed.transitionDuration, "0s");
      assert.equal(failed.animationName, "none");
      await page.evaluate(() => window.__motionFixture.release());
      await settled(page);
      assert(!(await animations(page)).some((item) => item.kind === "result"));
      await screenshot(page, label + "-failed");
      return { status: failed, animationStarts: await animations(page) };
    });
    await check(
      label + ": cancellation status immediate; no success/intermediate result",
      async () => {
        await page.evaluate(() => {
          window.__motionFixture.next("running");
          window.__motionFixture.clearAnimations();
        });
        await send(page, "模拟取消状态");
        await expect
          .poll(() => page.evaluate(() => window.__motionFixture.streamReady()))
          .toBe(true);
        await page.getByRole("button", { name: "取消运行", exact: true }).click();
        await expect(page.locator('[data-run-status="cancelled"]')).toBeVisible();
        await settled(page);
        const cancelled = await styles(page.locator('[data-run-status="cancelled"]'));
        assert.equal(cancelled.transitionDuration, "0s");
        assert(!(await animations(page)).some((item) => item.kind === "result"));
        await screenshot(page, label + "-cancelled");
        return { status: cancelled };
      },
    );
    await check(label + ": reading previous messages retains scroll on result", async () => {
      await page.getByRole("button", { name: /^运行详情/ }).click();
      await page.getByRole("button", { name: /历史记录：长篇证据/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => window.__motionFixture.next("running"));
      await send(page, "等待结果时阅读历史");
      await expect.poll(() => page.evaluate(() => window.__motionFixture.streamReady())).toBe(true);
      const region = page.getByRole("region", { name: "Agent 对话" });
      await region.evaluate((element) => {
        element.scrollTop = 80;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const before = await region.evaluate((element) => element.scrollTop);
      await page.evaluate(() => window.__motionFixture.emit("completed"));
      await settled(page);
      const after = await region.evaluate((element) => element.scrollTop);
      assert(Math.abs(before - after) <= 1, `Reading history jumped from ${before} to ${after}`);
      await screenshot(page, label + "-history-scroll");
      return { before, after };
    });
    await page.context().close();
  }

  for (const width of [1440, 390]) {
    const label = width > 600 ? "desktop" : "mobile";
    const page = await makePage({ width, height: width > 600 ? 900 : 844 }, "reduce");
    await check(
      label + ": reduced motion disables message/composer/disclosure motion",
      async () => {
        await send(page, "减少动态效果验证");
        await settled(page);
        assert.equal((await animations(page)).length, 0);
        for (const message of await page.locator("[data-workbench-message]").all()) {
          const css = await styles(message);
          assert.equal(css.animationName, "none");
          assert.equal(css.transform, "none");
        }
        const composer = await styles(page.locator(".workbench-composer-action"));
        assert.equal(composer.transitionDuration, "0s");
        assert.equal(composer.transform, "none");
        await page.getByRole("button", { name: /^运行详情/ }).click();
        const toggle = page.getByRole("button", { name: "已确认的客户偏好", exact: true });
        await toggle.scrollIntoViewIfNeeded();
        await toggle.focus();
        await toggle.press("Enter");
        const id = await toggle.getAttribute("aria-controls");
        const panel = page.locator(`[id=${JSON.stringify(id)}]`);
        const disclosure = await styles(panel);
        assert.equal(disclosure.transitionDuration, "0s");
        const chevron = await styles(toggle.locator("svg"));
        assert.equal(chevron.transform, "none");
        assert.equal(chevron.transitionDuration, "0s");
        await screenshot(page, label + "-reduced-motion-details");
        return { composer, disclosure, chevron, animationStarts: await animations(page) };
      },
    );
    await page.context().close();
  }

  const memoryPage = await makePage(
    { width: 390, height: 844 },
    "no-preference",
    "?surface=memory",
  );
  await check("mobile: actual CustomerMemoryPanel disclosure", async () => {
    await expect(memoryPage.getByText("客户希望通过文字接收明确的下一步建议。")).toBeVisible();
    const toggle = memoryPage.getByRole("button", { name: "同步与清理状态（运维）", exact: true });
    await toggle.focus();
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const id = await toggle.getAttribute("aria-controls");
    const panel = memoryPage.locator(`[id=${JSON.stringify(id)}]`);
    assert.equal((await styles(panel)).transitionDuration, "0.19s");
    await panel.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await screenshot(memoryPage, "mobile-memory-expanded");
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    return { duration: "190ms" };
  });
  await memoryPage.context().close();
  await check("no browser errors or external requests", async () => {
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    return {
      consoleErrors: report.consoleErrors,
      blockedExternalRequests: report.externalRequests,
    };
  });
} catch (error) {
  report.cases.push({
    name: "harness execution",
    passed: false,
    error: String(error.stack ?? error),
  });
  process.stderr.write(String(error.stack ?? error) + "\n");
} finally {
  await browser?.close();
  await server.close();
  report.passed = report.cases.filter((item) => item.passed).length;
  report.failed = report.cases.filter((item) => !item.passed).length;
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
}
process.stdout.write(
  JSON.stringify({
    passed: report.passed,
    failed: report.failed,
    report: path.join(out, "report.json"),
    screenshots: report.screenshots.length,
  }) + "\n",
);
if (report.failed) process.exitCode = 1;
