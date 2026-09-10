import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";

// 鲸息（pgg-jingxi ）呼吸遥测只读接口
// 读取扩展落盘的 breath-latest.json（仅元数据：轮次/token/时长/曲线/事件轨）。
// 路径固定为宿主运行时资产：~/.pi/agent/data/jingxi/state/breath-latest.json
const STATE_FILE = join(homedir(), ".pi", "agent", "data", "jingxi", "state", "breath-latest.json");

export async function GET() {
  try {
    if (!existsSync(STATE_FILE)) {
      return NextResponse.json({ ok: false, error: "jingxi state not found (extension may not be loaded)" }, { status: 404 });
    }
    const raw = readFileSync(STATE_FILE, "utf8");
    const payload = JSON.parse(raw);
    // 输出结构化呼吸数据（前端 JingxiPanel 使用）
    return NextResponse.json({
      ok: true,
      schema: payload.schema ?? "pgg-jingxi/breath-latest",
      updatedAt: payload.updatedAt,
      breathing: {
        turns: payload.turns ?? 0,
        toolSteps: payload.toolSteps ?? 0,
        errors: payload.errors ?? 0,
        compactions: payload.compactions ?? 0,
        totalTokens: (payload.totalInput ?? 0) + (payload.totalOutput ?? 0),
        totalInput: payload.totalInput ?? 0,
        totalOutput: payload.totalOutput ?? 0,
        cost: payload.totalCost ?? 0,
        sessionStartedAt: payload.sessionStartedAt,
      },
      curve: payload.curve ?? [],
      ticks: payload.ticks ?? [],
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}