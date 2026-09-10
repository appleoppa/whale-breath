"use client";

// ─── JingxiBreathingWidget — 左侧 sidebar 入口 + 浮层展开 ─────────────────
// 折叠态：聊天区左下角一个小鲸鱼按钮（不占布局空间，仅 margin 偏移）。
// 展开态：点击后面板浮在按钮右侧（绝对定位，覆盖消息区）。
// 参考 DSH 鲸息 sidebar rail 模式（40×40px 入口 → wide 浮层）。
// 数据从 /api/jingxi 拉取，3s 轮询。
import { useCallback, useEffect, useRef, useState } from "react";
import { JingxiPanel, type JingxiPayload } from "./JingxiPanel";

const STORAGE_KEY = "pgg-jingxi-collapsed";

function toPayload(d: any): JingxiPayload {
  const b = d.breathing ?? {};
  const now = Date.now();
  const start = new Date(b.sessionStartedAt ?? now).getTime();
  const durMs = now - start;
  const out = b.totalOutput ?? 0;
  const tps = durMs > 0 ? Math.round(out / (durMs / 1000)) : 0;
  return {
    v: 1, ts: now, sessionStartedAt: start, durMs, tps,
    totalTokens: b.totalTokens ?? 0, totalInput: b.totalInput ?? 0, totalOutput: out,
    turns: b.turns ?? 0, toolSteps: b.toolSteps ?? 0, turnTools: 0,
    errors: b.errors ?? 0, compactions: b.compactions ?? 0, cost: b.cost ?? 0,
    curve: (d.curve ?? []).map((c: any) => ({ tMs: c.tMs ?? 0, tokens: c.tokens ?? 0 })),
    ticks: (d.ticks ?? []).map((t: any) => ({ tMs: t.tMs ?? 0, kind: t.kind ?? "tool" })),
    textLines: [],
  };
}

export default function JingxiBreathingWidget() {
  const [payload, setPayload] = useState<JingxiPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "true") setExpanded(true);
    } catch { /* */ }
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      try { localStorage.setItem(STORAGE_KEY, String(!prev)); } catch { /* */ }
      return !prev;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/jingxi", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.ok && data.breathing) {
          setPayload(toPayload(data));
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const hasError = (payload?.errors ?? 0) > 0;

  return (
    <div className="jx-sidebar" ref={panelRef}>
      <button
        className={`jx-sidebar-btn${expanded ? " is-active" : ""}${hasError ? " has-error" : ""}`}
        onClick={toggle}
        title={expanded ? "收起鲸息" : "展开鲸息"}
        aria-expanded={expanded}
      >
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M4 14c0-4 3-7 8-7s8 3 8 7c0 2-1.2 3.6-3.4 4.4-.6.2-.8-.4-.6-.9.5-1.2.8-2.3.8-3.2 0-3-2.6-5-4.8-5s-5 2-5 5c0 1 .3 2 .8 3.1.2.5 0 1.1-.6.9C5.2 17.6 4 16 4 14z" fill="currentColor" />
        </svg>
        {payload && !expanded && (
          <span className="jx-sidebar-badge">{payload.turns}</span>
        )}
      </button>

      {expanded && (
        <div className="jx-float-panel">
          <div className="jx-float-header">
            <span className="jx-float-title">🐳 鲸息呼吸</span>
            <button className="jx-float-close" onClick={toggle} title="收起">▾</button>
          </div>
          {!payload
            ? <div className="jx-loading">{err ? `🐳 鲸息待唤醒：${err}` : "🐳 鲸息呼吸采集中…"}</div>
            : <JingxiPanel payload={payload} />}
        </div>
      )}
    </div>
  );
}