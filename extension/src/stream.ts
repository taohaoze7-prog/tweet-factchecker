// 流式核查事件 + fetch-based SSE 解析。
// EventSource 只支持 GET，推文文本要走 POST body，故用 fetch + ReadableStream 自解析 SSE。
// 事件形状镜像后端 stream_events.py，复用 types.ts 的契约对象。

import type { Claim, ClaimResult, FactCheckResult } from "./types";

export type StreamEvent =
  | { type: "claims"; claims: Claim[] }
  | { type: "claim"; result: ClaimResult }
  | { type: "done"; result: FactCheckResult }
  | { type: "error"; message: string };

/** 从 fetch 的 SSE 响应体里逐条解析出 StreamEvent。*/
export async function* parseSSE(resp: Response): AsyncGenerator<StreamEvent> {
  if (!resp.body) throw new Error("响应无 body，无法流式读取");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 记录以空行（\n\n）分隔
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const record = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const ev = parseRecord(record);
      if (ev) yield ev;
    }
  }
}

/** 后端每条 data 即完整事件 JSON（含 type 字段），直接解析。*/
function parseRecord(record: string): StreamEvent | null {
  let data = "";
  for (const line of record.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}
