// 后端 HTTP 契约调用。frontend worktree 在此对接 POST /factcheck。

import type { FactCheckRequest, FactCheckResult } from "./types";

const BACKEND_URL = "http://localhost:8000";

export async function factCheck(
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
