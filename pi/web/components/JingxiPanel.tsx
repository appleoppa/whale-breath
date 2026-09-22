"use client";

// ─── JingxiPanel — Pi 原生「鲸息」呼吸遥测面板 ─────────────────────────────
// 视觉语言忠实参考 DSH whale-breath (dsh-jingxi V1.0.2 Pure Breath)：
//   - 顶栏：状态点 + 标题 lockup（鲸鱼 mark + 喷水）
//   - 五张事实卡（图标 + 数值 + 标签，状态色点缀）
//   - SVG 呼吸曲线（渐变填充 + 网格 + 事件刻度 + y 轴标签）
//   - 事件轨（tool / error / compaction 彩色圆点）
//   - 呼吸阶段（idle / breath / cruise / peak ...）状态语言
// 数据：扩展 pgg-jingxi 输出的 JINGXI_V1 JSON 结构化负载。
// 原则：只读遥测；曲线与卡均为真实元数据；样本不足显示空态，不伪造。
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";

// ── 类型 ───────────────────────────────────────────────────────────────────
export interface JingxiPoint { tMs: number; tokens: number; }
export interface JingxiTick { tMs: number; kind: "tool" | "error" | "compaction"; }
export interface JingxiPayload {
  v: number;
  ts: number;
  sessionStartedAt: number;
  durMs: number;
  tps: number;
  totalTokens: number;
  totalInput: number;
  totalOutput: number;
  turns: number;
  toolSteps: number;
  turnTools: number;
  errors: number;
  compactions: number;
  cost: number;
  curve: JingxiPoint[];
  ticks: JingxiTick[];
  textLines: string[];
  // ── 解读层（扩展 V1.0.4 起提供；旧负载缺失时为 undefined） ──
  avgTps?: number | null;
  rateQuality?: "exact" | "estimated" | "none";
  rateGrade?: string;
  rateGradeLabel?: string;
  cacheHitRate?: number | null;
  cacheRead?: number;
  cacheWrite?: number;
  uncachedInput?: number;
  phase?: string;
  phaseLabel?: string;
  phaseDetail?: string;
  phaseIndex?: number;
  jingxiVersion?: string;
}

export const JINGXI_MARKER = "JINGXI_V1:";

export function parseJingxiWidget(lines: string[] | undefined): JingxiPayload | null {
  if (!lines || lines.length === 0) return null;
  const first = lines[0] ?? "";
  if (!first.startsWith(JINGXI_MARKER)) return null;
  try {
    const payload = JSON.parse(first.slice(JINGXI_MARKER.length)) as JingxiPayload;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.curve)) return null;
    return payload;
  } catch {
    return null;
  }
}

// API 返回结构 → JingxiPayload（用于挂载时拉取）已由 JingxiBreathingWidget 的 toPayload 承担；
// 本文件仅解析扩展 setWidget 通道（JINGXI_V1 标记）——保留 parseJingxiWidget 向后兼容。

// ── 小工具 ─────────────────────────────────────────────────────────────────
const fmtNum = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};
const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtCost = (c: number): string => {
  if (!Number.isFinite(c) || c <= 0) return "$0.00";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
};

// Breath 阶段（真实空态 + 活跃状态）
// 扩展 V1.0.4 起在负载里给出权威 phase（六阶段模型，由真实速度/工具节点推导）；
// 旧负载没有该字段时回落到本地粗判，保证向后兼容。
type Phase = "idle" | "breath" | "cruise" | "peak" | "turbulence";
function phaseOf(p: JingxiPayload): Phase {
  if (p.phase) {
    switch (p.phase) {
      case "turbulence":
        return "turbulence";
      case "cruise":
        return "cruise";
      case "acceleration":
        return "peak";
      case "landing":
      case "done":
        return "cruise";
      case "ignition":
        return p.turns === 0 ? "idle" : "breath";
      default:
        break;
    }
  }
  if (p.errors > 0) return "turbulence";
  if (p.turns === 0) return "idle";
  if (p.tps >= 30) return "peak";
  if (p.turnTools > 0 || p.toolSteps > 0) return "breath";
  return "cruise";
}
const PHASE_META: Record<Phase, { label: string; color: string }> = {
  idle: { label: "静默待命", color: "var(--jx-primary)" },
  breath: { label: "呼吸中", color: "var(--jx-tool)" },
  cruise: { label: "巡航", color: "var(--jx-model)" },
  peak: { label: "峰值涌动", color: "var(--jx-input)" },
  turbulence: { label: "湍流", color: "var(--jx-error)" },
};

// 阶段圆点动效开关：仅在真正活跃（非静默）时呼吸，静态时不动。
function phaseIsActive(phase: Phase): boolean {
  return phase === "breath" || phase === "peak";
}

// ── 事实卡 ────────────────────────────────────────────────────────────────
const FACTS = [
  { key: "tokens", label: "Token 总量", icon: "◎", color: "var(--jx-primary)" },
  { key: "duration", label: "会话时长", icon: "◷", color: "var(--jx-model)" },
  { key: "turns", label: "轮次 / 步数", icon: "◉", color: "var(--jx-tool)" },
  { key: "speed", label: "出词速度", icon: "≈", color: "var(--jx-input)" },
  { key: "cache", label: "缓存命中", icon: "◈", color: "var(--jx-primary)" },
  { key: "health", label: "异常 / 重试", icon: "△", color: "var(--jx-error)" },
] as const;

function factValue(p: JingxiPayload, key: string): { value: string; sub: string; tone?: "success" | "brand" | "error" } {
  switch (key) {
    case "tokens":
      return { value: fmtNum(p.totalTokens), sub: `in ${fmtNum(p.totalInput)} · out ${fmtNum(p.totalOutput)}` };
    case "duration":
      return { value: fmtMs(p.durMs), sub: `本会话 ${fmtCost(p.cost)}` };
    case "turns":
      return { value: `${p.turns}`, sub: `${p.toolSteps} 步 · 当前 Turn ${p.turnTools} 工具` };
    case "speed": {
      // 优先用解读层的分级（扩展 V1.0.4）；缺失时回落到本地阈值。
      // 速度质量非「估算」时不标实时，避免把估算值说成实时值。
      const label = p.rateGradeLabel ?? (p.tps >= 30 ? "涌动" : p.tps > 0 ? "巡航" : "空态");
      const avg = p.avgTps ?? null;
      const quality = p.rateQuality === "estimated" ? "估算" : p.rateQuality === "exact" ? "实时" : "无数据";
      return {
        value: label,
        sub: avg === null ? `${p.tps} tok/s · ${quality}` : `均速 ${avg} tok/s · ${quality}`,
        tone: label === "疾涌" || label === "涌动" ? "success" : "brand",
      };
    }
    case "cache": {
      // 缓存命中率：分母为 0（无缓存活动）时显示「无数据」，不显示 0%。
      const rate = p.cacheHitRate ?? null;
      return {
        value: rate === null ? "无数据" : `${Math.round(rate * 100)}%`,
        sub: `read ${fmtNum(p.cacheRead ?? 0)} · write ${fmtNum(p.cacheWrite ?? 0)}`,
        tone: rate === null ? undefined : rate >= 0.5 ? "success" : "brand",
      };
    }
    case "health":
      return { value: `${p.errors}`, sub: `${p.compactions} 次压缩`, tone: p.errors > 0 ? "error" : "success" };
    default:
      return { value: "", sub: "" };
  }
}

// ── SVG 呼吸曲线 ──────────────────────────────────────────────────────────
function BreathCurve({ p }: { p: JingxiPayload }) {
  const W = 560, H = 96, PADX = 6, PADT = 8, PADB = 2;
  const path = useMemo(() => {
    const pts = p.curve;
    if (pts.length < 2) return { line: "", fill: "", dots: [] as { x: number; y: number; tokens: number }[] };
    const max = Math.max(...pts.map((q) => q.tokens), 1);
    const t0 = pts[0].tMs, t1 = pts[pts.length - 1].tMs;
    const span = Math.max(t1 - t0, 1);
    const xs = pts.map((q) => PADX + ((q.tMs - t0) / span) * (W - PADX * 2));
    const ys = pts.map((q) => H - PADB - (q.tokens / max) * (H - PADT - PADB));
    const line = `M ${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" L ")}`;
    const fill = `${line} L ${xs[xs.length - 1].toFixed(1)},${H - PADB} L ${xs[0].toFixed(1)},${H - PADB} Z`;
    const dots = pts.map((q, i) => ({ x: xs[i], y: ys[i], tokens: q.tokens }));
    return { line, fill, dots };
  }, [p.curve, W, H, PADX, PADT, PADB]);

  if (p.curve.length < 2) {
    return (
      <div className="jx-curve-empty">
        <span className="jx-curve-empty-mark">◍</span>
        <div>
          <div className="jx-curve-empty-title">呼吸样本采集中</div>
          <div className="jx-curve-empty-sub">不会混用最近 Turn 的曲线——等真实数据积累</div>
        </div>
      </div>
    );
  }

  // y 轴标签（3 档）
  const ymax = Math.max(...p.curve.map((q) => q.tokens), 1);
  const yLabels = [ymax, Math.round(ymax / 2), 0].map((v, i) => (
    <span key={i} className="jx-yaxis-label" style={{ bottom: `${(i / 2) * (H - PADT - PADB) + PADT - 6}px` }}>
      {fmtNum(v)}
    </span>
  ));

  return (
    <div className="jx-curve-wrap">
      <svg className="jx-curve-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* 网格线 */}
        {[0, 0.5, 1].map((g) => (
          <line key={g} x1="0" x2={W} y1={PADT + g * (H - PADT - PADB)} y2={PADT + g * (H - PADT - PADB)}
            className="jx-curve-gridline" />
        ))}
        {/* 梯度填充 */}
        <defs>
          <linearGradient id="jx-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--jx-tool)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--jx-tool)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={path.fill} fill="url(#jx-fill)" />
        {/* 事件刻度 */}
        {p.ticks.slice(-16).map((t, i) => {
          const x = PADX + ((t.tMs - p.curve[0].tMs) / Math.max(p.curve[p.curve.length - 1].tMs - p.curve[0].tMs, 1)) * (W - PADX * 2);
          if (x < PADX || x > W - PADX) return null;
          return <line key={i} x1={x} x2={x} y1="2" y2={H - 2} className="jx-curve-ticksvg" />;
        })}
        {/* 曲线线 */}
        <path d={path.line} className="jx-curve-line" fill="none" />
        {/* 数据点 */}
        {path.dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.tokens >= 5000 ? 2.6 : d.tokens >= 1000 ? 1.8 : 1.2} className="jx-curve-dot" />
        ))}
      </svg>
      {yLabels}
      <div className="jx-curve-footer">
        <span>◂ 最近 Turn</span>
        <span>{fmtNum(ymax)} tok/次</span>
        <span>本次 ▸</span>
      </div>
    </div>
  );
}

// ── 事件轨 ─────────────────────────────────────────────────────────────────
const TICK_ICONS: Record<string, { icon: string; cls: string }> = {
  tool: { icon: "◈", cls: "jx-tick-tool" },
  error: { icon: "▲", cls: "jx-tick-error" },
  compaction: { icon: "▣", cls: "jx-tick-compact" },
};
function EventRail({ p }: { p: JingxiPayload }) {
  const ticks = p.ticks.slice(-14);
  return (
    <div className="jx-event-rail">
      <span className="jx-event-rail-label">事件轨</span>
      {ticks.length === 0 ? (
        <span className="jx-event-rail-empty">暂无事件 —— 只读遥测，不读内容</span>
      ) : (
        <span className="jx-event-rail-icons">
          {ticks.map((t, i) => {
            const meta = TICK_ICONS[t.kind] ?? { icon: "·", cls: "" };
            return (
              <span key={i} className={`jx-tick ${meta.cls}`} title={`${t.kind} @ ${new Date(t.tMs).toLocaleTimeString()}`}>
                {meta.icon}
              </span>
            );
          })}
        </span>
      )}
      <span className="jx-event-rail-note">
        {p.toolSteps} 步 · {p.errors} 异常 · {p.compactions} 压缩
      </span>
    </div>
  );
}

// ── 主面板（挂载时自取数据） ────────────────────────────────────────────────
export function JingxiPanel({ payload }: { payload: JingxiPayload }) {
  const phase = phaseOf(payload);
  const meta = PHASE_META[phase];

  return (
    <div className="jx-panel" data-phase={phase}>
      {/* 顶栏 */}
      <div className="jx-header">
        <span className="jx-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            {/* 鲸鱼 + 喷水 */}
            <path d="M4 14c0-4 3-7 8-7s8 3 8 7c0 2-1.2 3.6-3.4 4.4-.6.2-.8-.4-.6-.9.5-1.2.8-2.3.8-3.2 0-3-2.6-5-4.8-5s-5 2-5 5c0 1 .3 2 .8 3.1.2.5 0 1.1-.6.9C5.2 17.6 4 16 4 14z"
              fill="currentColor" />
            <path d="M7 11c0-2 1.2-3.4 3.2-4 .5-.2 1 .3.8.8-.5 1.5-1.4 2.6-3 3.2-.4.1-.8-.2-1-.7z"
              fill="var(--jx-tool)" opacity="0.85" />
            <path d="M12 6c.3-.6.9-1 1.6-1.1.5 0 .8.5.6.9-.6 1.6-1.5 2-2.2 2-.6 0-1.2-.4-1.4-1 .2-.3.5-.4.4-.6-.6-.9-1.4-1.5-2.4-1.8-1-.3-2-.4-3-.6-.6-.1-.7-.9-.1-1 .6-.1 1.3-.1 1.9 0 2 .2 3.8 1 5.2 2.6z"
              fill="var(--jx-primary)" opacity="0.9" />
          </svg>
        </span>
        <div className="jx-header-title">
          <span className="jx-title">鲸息</span>
          <span className="jx-subtitle">Pi 呼吸遥测 · 只读</span>
        </div>
        <span className="jx-phase-dot" data-state={phaseIsActive(phase) ? "active" : "static"} style={{ background: meta.color }} />
        <span className="jx-phase-label" style={{ color: meta.color }}>{payload.phaseLabel ?? meta.label}</span>
        <span className="jx-version">v{(payload.jingxiVersion ?? "1.0.2").replace(/^(\d+\.\d+\.\d+).*$/, "$1")}</span>
      </div>

      {/* 五张事实卡 */}
      <div className="jx-facts">
        {FACTS.map((f) => {
          const fv = factValue(payload, f.key);
          const tone = fv.tone ? ` jx-tone-${fv.tone}` : "";
          return (
            <div key={f.key} className={`jx-fact${tone}`}>
              <span className="jx-fact-icon" style={{ color: f.color }}>{f.icon}</span>
              <div className="jx-fact-body">
                <span className="jx-fact-value">{fv.value}</span>
                <span className="jx-fact-label">{f.label}</span>
                {fv.sub && <span className="jx-fact-sub">{fv.sub}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* 呼吸曲线 */}
      <div className="jx-curve">
        <div className="jx-curve-head">
          <span>呼吸曲线</span>
          <span className="jx-curve-legend">
            <i style={{ background: "var(--jx-tool)" }} />工具 <i style={{ background: "var(--jx-model)" }} />模型
          </span>
        </div>
        <BreathCurve p={payload} />
      </div>

      {/* 事件轨 */}
      <EventRail p={payload} />
    </div>
  );
}