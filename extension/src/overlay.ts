// 浮层渲染：把 FactCheckResult 展示在推文旁。frontend worktree 负责样式与交互。

import type { FactCheckResult, Verdict } from "./types";

const VERDICT_LABEL: Record<Verdict, string> = {
  true: "属实",
  mostly_true: "基本属实",
  mixed: "真假参半",
  mostly_false: "大体不实",
  false: "不实",
  unverifiable: "无法核实",
};

const VERDICT_COLOR: Record<Verdict, string> = {
  true: "#1a7f37",
  mostly_true: "#3fb950",
  mixed: "#d29922",
  mostly_false: "#db6d28",
  false: "#cf222e",
  unverifiable: "#6e7781",
};

/** 在推文节点旁渲染核查结果浮层。*/
export function renderOverlay(
  anchor: HTMLElement,
  result: FactCheckResult
): void {
  // TODO(frontend): 替换为正式 UI（卡片 / 证据列表 / 展开收起）。以下为最小可视化。
  const box = document.createElement("div");
  box.className = "fc-overlay";
  box.style.borderLeft = `4px solid ${VERDICT_COLOR[result.overall_verdict]}`;
  box.style.padding = "8px 12px";
  box.style.margin = "8px 0";
  box.style.fontSize = "13px";

  const title = document.createElement("strong");
  title.textContent = `${VERDICT_LABEL[result.overall_verdict]} · ${Math.round(
    result.overall_confidence * 100
  )}%`;
  title.style.color = VERDICT_COLOR[result.overall_verdict];
  box.appendChild(title);

  const summary = document.createElement("p");
  summary.textContent = result.summary;
  box.appendChild(summary);

  anchor.appendChild(box);
}
