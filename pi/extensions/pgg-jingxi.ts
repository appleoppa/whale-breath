// pgg-jingxi.ts — Pi 原生「鲸息」呼吸遥测解读层
//
// 理念：等价移植 DSH whale-breath（dsh-jingxi V1.0.2 Pure Breath）到 Pi。
// 鲸息 = 只读 Turn 遥测解读层：侧栏一缕呼吸（widget），点击即见呼吸轨迹浮层
// （五张事实卡 + 一条呼吸曲线 + 一条事件轨）。没有计费/额度/面板迷宫。
//
// 为什么是「原生移植」而不是「搬运」：
//   DSH 侧鲸息（lib/index.js）深度绑定 cordis 事件（ctx.on('session/event')）、
//   sessionQuery、@deepseek-ai/dsh-client-runtime，代码层面过不来。
//   但 Pi 自带等价遥测源（extension events，见 docs/extensions.md）：
//     turn_start/turn_end            → 轮次/步数、会话时长
//     message_end (usage)            → token/cost 事实
//     tool_execution_start/end       → 工具次数、异常/失败
//     session_before_compact         → 压缩次数（事件轨 retry/compaction 刻度）
//   Web UI 渲染 ctx.ui.setWidget（components/ExtensionWidgets.tsx）= 呼吸浮层。
//
// 授权红线（与鲸息一致）：
//   - 只读遥测：绝不拦截/改写消息、绝不参与模型调用。
//   - 不存 raw content / 不存 prompt 文本 / 不存 tool 参数：事件刻度与曲线点
//     均为元数据（数字+时间），落盘也只有数字与计数。
//   - fail-closed：写不了/读不到数据就显示真实空态，不伪造曲线。
//   - 落盘仅宿主运行时 ~/.pi/agent/data/jingxi/state/breath-latest.json，
//     绝不写 PGG-WIKI、绝不读/写凭据。
//
// 安装：放入 ~/.pi/agent/extensions/ 自动发现；/reload 或重启 Pi 后生效。

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 位置与容量 ──────────────────────────────────────────────────────────
const STATE_DIR = join(homedir(), ".pi", "agent", "data", "jingxi", "state");
const STATE_FILE = join(STATE_DIR, "breath-latest.json");
const CURVE_CAP = 64;      // 呼吸曲线最大点数（trailing）
const EVENT_TICK_CAP = 32; // 事件轨最大刻度数
const PERSIST_MS = 800;    // 落盘 throttle（与鲸息 500ms 同级）

// ── 会话内活状态（内存真相，文件只是持久化镜像） ──────────────────────────
interface Tick { tMs: number; kind: "tool" | "error" | "compaction"; }
interface CurvePoint { tMs: number; tokens: number; }

const live = {
  sessionStartedAt: Date.now(),
  sessionId: "",
  turns: 0,                 // 轮次总数（turn_start 次数）
  toolSteps: 0,             // 工具执行总数
  errors: 0,                // 工具失败/出错数
  compactions: 0,           // 压缩次数
  turnTools: 0,             // 当前 Turn 工具次数（turn_end 时并入并清零）
  totalInput: 0,            // 累计 input tokens（含 cache）
  totalOutput: 0,           // 累计 output tokens
  totalCost: 0,             // 累计成本（$）
  curve: [] as CurvePoint[], // 每轮 token 速度点（元数据）
  ticks: [] as Tick[],       // 事件轨（元数据）
  idle: true,
  lastWidgetLines: [] as string[],
};

let persistTimer: any = undefined;
let widgetTimer: any = undefined;

const NUM = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0);
const round2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
};

function pushTick(kind: Tick["kind"], tMs = Date.now()): void {
  const last = live.ticks[live.ticks.length - 1];
  if (last && last.kind === kind && (tMs - last.tMs) < 2000) return; // 防抖
  live.ticks.push({ tMs, kind });
  if (live.ticks.length > EVENT_TICK_CAP) live.ticks.splice(0, live.ticks.length - EVENT_TICK_CAP);
}

function addCurvePoint(tokens: number, tMs = Date.now()): void {
  if (!Number.isFinite(tokens) || tokens < 0) return;
  live.curve.push({ tMs, tokens });
  if (live.curve.length > CURVE_CAP) live.curve.splice(0, live.curve.length - CURVE_CAP);
}

// Pi Usage 结构（docs/session-format.md 实查）：
//   { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }
function usageOf(message: any): { input: number; output: number; cost: number } {
  const u = message?.usage;
  if (!u || typeof u !== "object") return { input: 0, output: 0, cost: 0 };
  return {
    input: NUM(u.input) + NUM(u.cacheRead) + NUM(u.cacheWrite),
    output: NUM(u.output),
    cost: NUM(u.cost?.total),
  };
}

// ── 呼吸视图（五张事实卡 + 曲线 + 事件轨，全为元数据） ────────────────────
// 前端 JingxiPanel 读取结构化 JSON 渲染；首行固定标记 JINGXI_V1: 供识别。
function buildBreathPayload(): string {
  const now = Date.now();
  const dur = now - live.sessionStartedAt;
  const tps = dur > 0 ? Math.round(live.totalOutput / (dur / 1000)) : 0;
  const lines = buildBreathLines();
  const payload = {
    v: 1,
    ts: now,
    sessionStartedAt: live.sessionStartedAt,
    durMs: dur,
    tps,
    totalTokens: live.totalInput + live.totalOutput,
    totalInput: live.totalInput,
    totalOutput: live.totalOutput,
    turns: live.turns,
    toolSteps: live.toolSteps,
    turnTools: live.turnTools,
    errors: live.errors,
    compactions: live.compactions,
    cost: Math.round(live.totalCost * 10000) / 10000,
    curve: live.curve.slice(-CURVE_CAP),
    ticks: live.ticks.slice(-EVENT_TICK_CAP),
    textLines: lines,
  };
  return `JINGXI_V1:${JSON.stringify(payload)}`;
}

function buildBreathLines(): string[] {
  const now = Date.now();
  const dur = now - live.sessionStartedAt;
  const tps = dur > 0 ? Math.round(live.totalOutput / (dur / 1000)) : 0;
  const lines: string[] = [];
  lines.push(`🐳 PGG 鲸息 · 会话呼吸`);
  lines.push(`· Token 总量  ${(live.totalInput + live.totalOutput).toLocaleString()}  (in ${live.totalInput.toLocaleString()} / out ${live.totalOutput.toLocaleString()})`);
  lines.push(`· 会话时长    ${fmtMs(dur)} (${live.turns} 轮)`);
  lines.push(`· 轮次/步数   ${live.turns} 轮 · ${live.toolSteps} 步 · 本 Turn ${live.turnTools} 工具`);
  lines.push(`· 出词速度    ${tps} tok/s · 成本 $${round2(live.totalCost)}`);
  lines.push(`· 异常/重试   ${live.errors} 异常 · ${live.compactions} 次压缩`);
  // 呼吸曲线（真实点，样本不足时不伪造）
  if (live.curve.length >= 2) {
    const max = Math.max(...live.curve.map((p) => p.tokens), 1);
    const bar = live.curve.slice(-12).map((p) => {
      const w = Math.max(1, Math.round((p.tokens / max) * 10));
      const tag = p.tokens >= 5000 ? "🐳" : p.tokens >= 1000 ? "🌊" : "·";
      return `${tag}${"▁".repeat(w)}`;
    }).join("");
    lines.push(`· 呼吸曲线    ${bar}`);
  } else {
    lines.push(`· 呼吸曲线    空态（样本不足；不会混用最近 Turn 的曲线）`);
  }
  // 事件轨（元数据刻度）
  if (live.ticks.length > 0) {
    const kinds: Record<string, string> = { tool: "🧰", error: "⚠️", compaction: "📦" };
    const rail = live.ticks.slice(-12).map((t) => kinds[t.kind] ?? "·").join("");
    lines.push(`· 事件轨      ${rail}`);
  }
  return lines;
}

function renderWidget(): void {
  // widget 首行放 JINGXI_V1 JSON 标记，前端优先读它渲染专用面板；
  // 无前端支持时回落为文本行（向后兼容）。
  live.lastWidgetLines = [buildBreathPayload()];
}

// ── 持久化（仅元数据；写失败静默 fail-closed） ────────────────────────────
function persist(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const payload = {
      schema: "pgg-jingxi/breath-latest",
      version: "1.0.2-pi-native",
      updatedAt: new Date().toISOString(),
      sessionStartedAt: new Date(live.sessionStartedAt).toISOString(),
      turns: live.turns,
      toolSteps: live.toolSteps,
      errors: live.errors,
      compactions: live.compactions,
      totalInput: live.totalInput,
      totalOutput: live.totalOutput,
      totalCost: live.totalCost,
      curve: live.curve.slice(-CURVE_CAP),
      ticks: live.ticks.slice(-EVENT_TICK_CAP),
    };
    writeFileSync(STATE_FILE, JSON.stringify(payload));
  } catch {
    /* fail-closed：不因落盘失败影响会话 */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = undefined; persist(); }, PERSIST_MS);
}

function resetSession(): void {
  live.sessionStartedAt = Date.now();
  live.turns = 0; live.toolSteps = 0; live.errors = 0;
  live.compactions = 0; live.turnTools = 0;
  live.totalInput = 0; live.totalOutput = 0; live.totalCost = 0;
  live.curve = []; live.ticks = []; live.idle = true; live.lastWidgetLines = [];
}

// ── 导出给命令/工具用的快照 ──────────────────────────────────────────────
function snapshot(): Record<string, unknown> {
  const lines = buildBreathLines();
  live.lastWidgetLines = lines;
  return {
    ok: true,
    jingxiVersion: "1.0.2-pi-native",
    sessions: { since: live.sessionStartedAt, turns: live.turns },
    metrics: {
      totalTokens: live.totalInput + live.totalOutput,
      outputTokens: live.totalOutput,
      durationMs: Date.now() - live.sessionStartedAt,
      toolSteps: live.toolSteps,
      errors: live.errors,
      compactions: live.compactions,
      costTotal: Math.round(live.totalCost * 10000) / 10000,
    },
    curvePoints: live.curve.length,
    tickKinds: live.ticks.map((t) => t.kind),
    view: live.curve.length >= 2 ? { kind: "breath" } : { kind: "idle" },
  };
}

// ── 扩展主体 ─────────────────────────────────────────────────────────────
export default function pggJingxi(pi: ExtensionAPI): void {
  const updateWidget = (ctx: any): void => {
    renderWidget();
    if (widgetTimer) return;
    widgetTimer = setTimeout(() => {
      widgetTimer = undefined;
      try {
        ctx.ui.setWidget("🐳 鲸息呼吸", live.lastWidgetLines);
      } catch { /* 无 UI 环境忽略 */ }
    }, 250);
  };

  // 会话生命周期
  pi.on("session_start", (_e: any, ctx: any) => {
    resetSession();
    updateWidget(ctx);
  });
  pi.on("session_shutdown", () => {
    persist();
  });

  // 轮次
  pi.on("turn_start", (_e: any, _ctx: any) => {
    live.turns += 1;
    live.turnTools = 0;
    live.idle = false;
  });
  pi.on("turn_end", (_e: any, ctx: any) => {
    live.turnTools = 0; // 本轮工具计数并入全局后清零，供下一轮“本 Turn”使用
    live.idle = true;
    schedulePersist();
    updateWidget(ctx);
  });

  // 消息（usage → token 事实）
  pi.on("message_end", (event: any, _ctx: any) => {
    if (!event?.message || event.message.role !== "assistant") return;
    const { input, output, cost } = usageOf(event.message);
    if (input + output + cost === 0) return;
    live.totalInput += input;
    live.totalOutput += output;
    live.totalCost += cost;
    addCurvePoint(output);
    schedulePersist();
  });

  // 工具执行（步数与异常刻度，不存参数）
  pi.on("tool_execution_start", (_e: any, _ctx: any) => {
    live.toolSteps += 1;
    live.turnTools += 1;
    pushTick("tool");
  });
  pi.on("tool_execution_end", (event: any, _ctx: any) => {
    if (event?.isError) {
      live.errors += 1;
      pushTick("error");
    }
  });

  // 压缩（compaction 刻度）
  pi.on("session_before_compact", (_e: any, _ctx: any) => {
    live.compactions += 1;
    pushTick("compaction");
  });

  // 只读命令 /jingxi：呼吸面板（无参数，不碰会话）
  pi.registerCommand("jingxi", {
    description: "显示 Pi 会话呼吸轨迹（Token/轮次/时长/曲线/事件轨，只读元数据）",
    handler: async (_args: string, ctx: any) => {
      const s = snapshot();
      const lines = live.lastWidgetLines.length > 0
        ? live.lastWidgetLines
        : buildBreathLines();
      ctx.ui.notify(`🐳 鲸息呼吸 · ${live.turns} 轮 · ${(s.metrics as any).totalTokens} tok · $${round2(live.totalCost)}`, "info");
      ctx.ui.widgetPanel?.("jingxi", lines); // Web 面板（存在时）
      return lines.join("\n");
    },
  });

  // 只读工具 jingxi_breath：LLM 可查询呼吸快照（用于回答「鲸息看见了什么」）
  pi.registerTool({
    name: "jingxi_breath",
    label: "鲸息呼吸快照",
    description: "只读返回当前 Pi 会话的呼吸遥测快照（轮次/Token/时长/工具步/异常/压缩/曲线点数）。不修改任何状态，不读取会话内容。",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify(snapshot(), null, 2) }], details: {} };
    },
  });
}