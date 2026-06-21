// 后端 HTTP 契约调用。POST /factcheck。
//
// 默认打真实后端。本地离线开发用 `VITE_USE_MOCK=true npm run build`，
// 直接返回 mocks/response.json，无需起后端。上线构建不带该 env → 自动走真接口，
// 杜绝"忘了改 const 把假数据发上线"的隐患。

import type { FactCheckRequest, FactCheckResult } from "./types";
import mockResponse from "../mocks/response.json";

const BACKEND_URL = "http://localhost:8000";

// 构建期开关（Vite 静态注入）：仅 VITE_USE_MOCK=true 时走假数据，缺省=打真后端。
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
// 模拟后端往返耗时，让"核查中…"状态可见。
const MOCK_LATENCY_MS = 600;

/** 真实后端调用：POST /factcheck。*/
async function factCheckRemote(
  req: FactCheckRequest
): Promise<FactCheckResult> {
  const resp = await fetch(`${BACKEND_URL}/factcheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    throw new Error(`factcheck failed: ${resp.status}`);
  }
  return (await resp.json()) as FactCheckResult;
}

/** Mock 调用：回填请求里的 tweet_id，其余沿用固定假数据。*/
async function factCheckMock(
  req: FactCheckRequest
): Promise<FactCheckResult> {
  await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS));
  const base = mockResponse as unknown as FactCheckResult;
  // 不可变更新：把当前推文 id 写进返回，避免直接改 mock 单例。
  return { ...base, tweet_id: req.tweet_id };
}

export async function factCheck(
  req: FactCheckRequest
): Promise<FactCheckResult> {
  return USE_MOCK ? factCheckMock(req) : factCheckRemote(req);
}
