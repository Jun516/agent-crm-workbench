# CRM 合并升级验证

`pnpm verify:crm` 复用工作台的 Playwright 端到端用例。它在本机 Supabase 和真实 Worker 上运行，由用例启动固定输出的本机模型服务。用例核对发布配置、Ontology 只读证据、刷新后回放、Mission 作用域拒绝，以及人工确认后工具执行和 Run 恢复。退出码可直接用作自动化验证结果。

## 本机运行

使用干净检出和可重建的本机 Supabase 测试库，按 [浏览器工作流](../../.github/workflows/e2e.yml) 初始化扩展和基线，安装 Playwright Chromium。在同一 Bash 会话中执行以下命令，再保持 Worker 运行。

```bash
pnpm e2e:env
set -a
source ./.env.e2e
set +a
unset INTERNAL_AGENT_RUN_STUB
export OPENROUTER_BASE_URL=http://127.0.0.1:48934/v1
pnpm e2e:build
pnpm exec tsx scripts/seed-e2e-credentials.ts
pnpm exec tsx scripts/seed-e2e-followup-agent.ts
NODE_ENV=production pnpm exec tsx workers/agent-worker/main.ts &
worker_pid=$!
trap 'kill "$worker_pid" 2>/dev/null || true' EXIT
```

Worker 的 `/healthz` 就绪后，在同一会话运行 `pnpm verify:crm`。用例写入合成数据，并输出 Playwright 的通过、失败与追踪记录。全量浏览器套件按工作流的 5 个分片运行，客户记忆闭环另走 `customer-memory-loop.spec.ts`。类型检查、Lint、单测、数据库不变量和生产构建各自有独立入口。

此用例的模型输出、客户、成本与审批动作均为测试数据。真实 Jev 裁决质量、真实消息渠道和 OpenCode 外部验证需要各自的联调环境。

## 数据库升级

已有环境先备份数据库并检查备份可读，再按版本顺序应用 `0409`–`0414`。`0409` 等迁移在既有 `ai_customer_memories` 表上演进结构，保留行及表身份。新建环境从 `supabase/baseline.sql` 初始化。安装和升级步骤见 [开发配置](../SETUP.md#rodar-as-migrations)。
