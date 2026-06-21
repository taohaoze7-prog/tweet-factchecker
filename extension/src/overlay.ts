// 浮层渲染：把 FactCheckResult 渲染成推文下方的核查卡片。
// frontend worktree 负责样式与交互。所有文本走 textContent，杜绝注入。

import type { Claim, ClaimResult, FactCheckResult, Stance, Verdict } from "./types";

const OVERLAY_CLASS = "fc-overlay";
const STYLE_ID = "fc-style";

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

const STANCE_LABEL: Record<Stance, string> = {
  supports: "支持",
  refutes: "反驳",
  neutral: "中立",
};

/** 把 0~1 的置信度转成一位小数的"可信分"，如 0.352 → "35.2"。*/
function toScore(confidence: number): string {
  return (confidence * 100).toFixed(1);
}

/** 注入一次全局样式（content script 启动时调用）。*/
export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${"fc-check-btn"} {
      cursor: pointer;
      border: 1px solid #536471;
      background: transparent;
      color: #1d9bf0;
      border-radius: 9999px;
      padding: 2px 12px;
      font-size: 13px;
      font-weight: 600;
      margin-left: 8px;
      line-height: 1.4;
    }
    .${"fc-check-btn"}:hover { background: rgba(29,155,240,0.1); }
    .${"fc-check-btn"}:disabled { opacity: 0.6; cursor: default; }

    .${OVERLAY_CLASS} {
      margin: 10px 0;
      border: 1px solid #2f3336;
      border-radius: 14px;
      background: #16181c;
      color: #e7e9ea;
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
    }
    .${OVERLAY_CLASS} .fc-head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid #2f3336;
    }
    .${OVERLAY_CLASS} .fc-score {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 64px;
    }
    .${OVERLAY_CLASS} .fc-score b { font-size: 26px; line-height: 1; }
    .${OVERLAY_CLASS} .fc-score span { font-size: 11px; color: #71767b; margin-top: 2px; }
    .${OVERLAY_CLASS} .fc-badge {
      align-self: flex-start;
      padding: 2px 10px;
      border-radius: 9999px;
      color: #fff;
      font-weight: 700;
      font-size: 12px;
    }
    .${OVERLAY_CLASS} .fc-summary { margin: 6px 0 0; color: #c9ccd1; }
    .${OVERLAY_CLASS} .fc-claims { padding: 10px 14px; }
    .${OVERLAY_CLASS} .fc-claim {
      padding: 8px 0;
      border-top: 1px dashed #2f3336;
    }
    .${OVERLAY_CLASS} .fc-claim:first-child { border-top: none; }
    .${OVERLAY_CLASS} .fc-claim-head { display: flex; align-items: center; gap: 8px; }
    .${OVERLAY_CLASS} .fc-claim-verdict { font-weight: 700; }
    .${OVERLAY_CLASS} .fc-claim-text { margin: 4px 0; color: #e7e9ea; }
    .${OVERLAY_CLASS} .fc-evidence { margin: 4px 0 0; padding-left: 16px; color: #aeb3b8; }
    .${OVERLAY_CLASS} .fc-evidence li { margin: 2px 0; }
    .${OVERLAY_CLASS} .fc-evidence a { color: #1d9bf0; text-decoration: none; }
    .${OVERLAY_CLASS} .fc-foot {
      padding: 8px 14px;
      border-top: 1px solid #2f3336;
      color: #71767b;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
    }
    .${OVERLAY_CLASS}.fc-error { border-color: #cf222e; }
    .${OVERLAY_CLASS} .fc-error-msg { padding: 12px 14px; color: #f0a0a0; }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

/** 移除推文上已有的卡片（重复核查时刷新）。*/
function clearExisting(anchor: HTMLElement): void {
  anchor.querySelectorAll(`:scope > .${OVERLAY_CLASS}`).forEach((n) => n.remove());
}

function buildBadge(verdict: Verdict): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "fc-badge";
  badge.textContent = VERDICT_LABEL[verdict];
  badge.style.background = VERDICT_COLOR[verdict];
  return badge;
}

function buildClaim(cr: ClaimResult): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "fc-claim";

  const head = document.createElement("div");
  head.className = "fc-claim-head";
  const verdict = document.createElement("span");
  verdict.className = "fc-claim-verdict";
  verdict.textContent = VERDICT_LABEL[cr.final_verdict];
  verdict.style.color = VERDICT_COLOR[cr.final_verdict];
  const conf = document.createElement("span");
  conf.textContent = `${toScore(cr.final_confidence)}分`;
  conf.style.color = "#71767b";
  head.append(verdict, conf);

  const text = document.createElement("p");
  text.className = "fc-claim-text";
  text.textContent = cr.claim.text;

  wrap.append(head, text);

  if (cr.evaluation.evidence.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "fc-evidence";
    for (const ev of cr.evaluation.evidence) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = ev.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = ev.title || ev.source_url;
      li.append(
        document.createTextNode(`[${STANCE_LABEL[ev.stance]}] `),
        link,
        document.createTextNode(` — ${ev.snippet}`)
      );
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }

  return wrap;
}

/** 在推文节点下方渲染核查结果卡片。*/
export function renderOverlay(
  anchor: HTMLElement,
  result: FactCheckResult
): void {
  injectStyles();
  clearExisting(anchor);

  const card = document.createElement("div");
  card.className = OVERLAY_CLASS;

  // ── 头部：可信分 + verdict 徽章 + 摘要 ──
  const head = document.createElement("div");
  head.className = "fc-head";

  const score = document.createElement("div");
  score.className = "fc-score";
  const scoreNum = document.createElement("b");
  scoreNum.textContent = toScore(result.overall_confidence); // 0.352 → "35.2"
  scoreNum.style.color = VERDICT_COLOR[result.overall_verdict];
  const scoreLbl = document.createElement("span");
  scoreLbl.textContent = "可信分";
  score.append(scoreNum, scoreLbl);

  const headRight = document.createElement("div");
  headRight.style.flex = "1";
  headRight.appendChild(buildBadge(result.overall_verdict));
  const summary = document.createElement("p");
  summary.className = "fc-summary";
  summary.textContent = result.summary;
  headRight.appendChild(summary);

  head.append(score, headRight);

  // ── 逐条断言 ──
  const claims = document.createElement("div");
  claims.className = "fc-claims";
  for (const cr of result.claims) claims.appendChild(buildClaim(cr));

  // ── 脚部：模型版本 + 耗时 ──
  const foot = document.createElement("div");
  foot.className = "fc-foot";
  const models = document.createElement("span");
  models.textContent = Object.entries(result.model_versions)
    .map(([k, v]) => `${k}:${v}`)
    .join(" · ");
  const timing = document.createElement("span");
  timing.textContent = `${result.processing_ms}ms`;
  foot.append(models, timing);

  card.append(head, claims, foot);
  anchor.appendChild(card);
}

/** 骨架行：断言已抽出、尚未评估完。*/
function buildPendingClaim(claim: Claim): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "fc-claim";
  const head = document.createElement("div");
  head.className = "fc-claim-head";
  const verdict = document.createElement("span");
  verdict.className = "fc-claim-verdict";
  verdict.textContent = "评估中…";
  verdict.style.color = "#71767b";
  head.appendChild(verdict);
  const text = document.createElement("p");
  text.className = "fc-claim-text";
  text.textContent = claim.text;
  wrap.append(head, text);
  return wrap;
}

/** 流式进度浮层：先出骨架，逐条填判定，done 时换成规范最终卡片。*/
export class ProgressOverlay {
  private readonly anchor: HTMLElement;
  private readonly claimsBox: HTMLElement;
  private readonly status: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  constructor(anchor: HTMLElement) {
    this.anchor = anchor;
    injectStyles();
    clearExisting(anchor);

    const card = document.createElement("div");
    card.className = OVERLAY_CLASS;

    const head = document.createElement("div");
    head.className = "fc-head";
    const score = document.createElement("div");
    score.className = "fc-score";
    const num = document.createElement("b");
    num.textContent = "…";
    num.style.color = "#71767b";
    const lbl = document.createElement("span");
    lbl.textContent = "核查中";
    score.append(num, lbl);
    const right = document.createElement("div");
    right.style.flex = "1";
    this.status = document.createElement("p");
    this.status.className = "fc-summary";
    this.status.textContent = "正在抽取断言…";
    right.appendChild(this.status);
    head.append(score, right);

    this.claimsBox = document.createElement("div");
    this.claimsBox.className = "fc-claims";

    card.append(head, this.claimsBox);
    anchor.appendChild(card);
  }

  /** 收到断言骨架：渲染待评估行。*/
  setClaims(claims: Claim[]): void {
    this.status.textContent = claims.length
      ? `核查 ${claims.length} 条断言…`
      : "未发现可核查断言。";
    this.claimsBox.replaceChildren();
    this.rows.clear();
    for (const c of claims) {
      const row = buildPendingClaim(c);
      this.rows.set(c.id, row);
      this.claimsBox.appendChild(row);
    }
  }

  /** 某条断言评完：用实际结果替换其骨架行。*/
  resolveClaim(cr: ClaimResult): void {
    const filled = buildClaim(cr);
    const row = this.rows.get(cr.claim.id);
    if (row) row.replaceWith(filled);
    else this.claimsBox.appendChild(filled);
    this.rows.set(cr.claim.id, filled);
  }

  /** 全部完成：替换为规范最终卡片（可信分头部 + 脚部模型/耗时）。*/
  finalize(result: FactCheckResult): void {
    renderOverlay(this.anchor, result);
  }
}

/** 核查失败时渲染错误卡片。*/
export function renderError(anchor: HTMLElement, err: unknown): void {
  injectStyles();
  clearExisting(anchor);
  const card = document.createElement("div");
  card.className = `${OVERLAY_CLASS} fc-error`;
  const msg = document.createElement("div");
  msg.className = "fc-error-msg";
  msg.textContent = `核查失败：${err instanceof Error ? err.message : String(err)}`;
  card.appendChild(msg);
  anchor.appendChild(card);
}
