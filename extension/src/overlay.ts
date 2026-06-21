// 核查卡渲染（Cinematic Intelligence）。
// P1 地基：整卡挂进 Shadow DOM，样式与 X 彻底隔离；令牌系统 + 主题探测。
// P2 静态卡：辉光玻璃面 + 环形可信度仪表 + 大裁决。动效见 P3。
// 所有文本走 textContent，杜绝注入；仅纯数字/静态 SVG 用 innerHTML。

import type { Claim, ClaimResult, FactCheckResult, Stance, Verdict } from "./types";

const HOST_CLASS = "fc-host";

const VERDICT_LABEL: Record<Verdict, string> = {
  true: "属实",
  mostly_true: "基本属实",
  mixed: "真假参半",
  mostly_false: "大体不实",
  false: "不实",
  unverifiable: "无法核实",
};

const VERDICT_EN: Record<Verdict, string> = {
  true: "True",
  mostly_true: "Mostly True",
  mixed: "Mixed",
  mostly_false: "Mostly False",
  false: "False",
  unverifiable: "Unverifiable",
};

const VERDICT_COLOR: Record<Verdict, string> = {
  true: "#3fe08a",
  mostly_true: "#46d6b4",
  mixed: "#f2c14e",
  mostly_false: "#ff9a4d",
  false: "#ff5860",
  unverifiable: "#8a93a0",
};

const STANCE_LABEL: Record<Stance, string> = {
  supports: "Supports",
  refutes: "Refutes",
  neutral: "Neutral",
};

const NEUTRAL = VERDICT_COLOR.unverifiable;
const RING_C = 2 * Math.PI * 50; // r=50

function pct(conf: number): number {
  return Math.round(Math.max(0, Math.min(1, conf)) * 100);
}

function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** easeOutCubic 补间，rAF 驱动；onUpdate 收到 0→1 的进度。*/
function tween(duration: number, onUpdate: (eased: number) => void): void {
  const start = performance.now();
  const frame = (now: number): void => {
    const p = Math.min(1, (now - start) / duration);
    onUpdate(1 - Math.pow(1 - p, 3));
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** 读 X 的正文背景亮度判明暗（X 主题独立于系统主题）。*/
function detectTheme(): "dark" | "light" {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) {
      const lum =
        (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
      return lum > 0.5 ? "light" : "dark";
    }
  } catch {
    /* noop */
  }
  return "dark";
}

const CARD_CSS = `
:host {
  all: initial;
  display: block;
  --ink: #f3f4f6; --ink-2: #a6adb6; --ink-3: #686f78;
  --glass-top: rgba(255,255,255,0.055); --glass-bot: rgba(255,255,255,0.012);
  --card-base: #0d0e11;
  --hair: rgba(255,255,255,0.09); --hair-2: rgba(255,255,255,0.05);
  --track: rgba(255,255,255,0.07);
  --accent: ${NEUTRAL};
  --display: "Fraunces","Georgia","Songti SC","Times New Roman",serif;
  --mono: "IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans: -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",system-ui,sans-serif;
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}
:host([data-theme="light"]) {
  --ink: #15181c; --ink-2: #41474e; --ink-3: #767d85;
  --glass-top: rgba(0,0,0,0.02); --glass-bot: rgba(0,0,0,0.005);
  --card-base: #ffffff;
  --hair: rgba(0,0,0,0.1); --hair-2: rgba(0,0,0,0.06);
  --track: rgba(0,0,0,0.08);
}
* { box-sizing: border-box; }

.fc-wrap { position: relative; margin: 14px 0 6px; animation: fcCardIn .42s cubic-bezier(.2,.7,.2,1) both; }
.fc-glow {
  position: absolute; inset: -2px -10px -30px; border-radius: 26px; z-index: 0;
  filter: blur(40px); opacity: .45; pointer-events: none;
  background: radial-gradient(60% 80% at 50% 0%, var(--accent), transparent 70%);
  transition: opacity .5s ease, background .5s ease;
}
.fc {
  position: relative; z-index: 1; border-radius: 18px; overflow: hidden;
  background: linear-gradient(180deg, var(--glass-top), var(--glass-bot)), var(--card-base);
  border: 1px solid var(--hair);
  box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 30px 70px -28px rgba(0,0,0,.85);
  backdrop-filter: blur(8px);
  font-size: 14px; color: var(--ink);
}
.fc-edge {
  height: 2px; width: 100%;
  background: linear-gradient(90deg, transparent, var(--accent) 30%, var(--accent) 70%, transparent);
  box-shadow: 0 0 14px var(--accent); opacity: .9;
  transition: background .5s ease, box-shadow .5s ease;
}

.fc-mast {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px 12px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .18em;
  text-transform: uppercase; color: var(--ink-3);
}
.fc-mast .brand { display: flex; align-items: center; gap: 9px; color: var(--ink-2); }
.fc-mast .brand .mark { color: var(--accent); font-size: 13px; transition: color .5s ease; }
.fc-mast .brand b { font-weight: 600; letter-spacing: .2em; }
.fc-mast .brand .sub { color: var(--ink-3); letter-spacing: .12em; }

.fc-hero { display: flex; align-items: center; gap: 20px; padding: 8px 20px 18px; }
.gauge { position: relative; width: 112px; height: 112px; flex: none; }
.gauge svg { transform: rotate(-90deg); display: block; }
.gauge .track { fill: none; stroke: var(--track); stroke-width: 6; }
.gauge .val {
  fill: none; stroke: var(--accent); stroke-width: 6; stroke-linecap: round;
  filter: drop-shadow(0 0 5px var(--accent));
  transition: stroke .5s ease;
}
.gauge .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.gauge .center .n { font-family: var(--display); font-weight: 400; font-size: 38px; line-height: .9; letter-spacing: -.02em; color: var(--ink); }
.gauge .center .n sup { font-size: 15px; color: var(--ink-3); top: -.9em; margin-left: 1px; }
.gauge .center .lbl { font-family: var(--mono); font-size: 8.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--ink-3); margin-top: 3px; }

.fc-hero-text { flex: 1; min-width: 0; }
.fc-verdict { font-family: var(--display); font-weight: 500; font-size: 40px; line-height: 1; letter-spacing: -.015em; color: var(--accent); margin: 2px 0 0; transition: color .5s ease; }
.fc-verdict-en { font-family: var(--mono); font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: var(--ink-3); margin-top: 9px; }
.fc-verdict-note { font-size: 12.5px; color: var(--ink-3); margin-top: 8px; }
.fc-verdict-note .bar { color: var(--accent); }

.fc-summary { padding: 0 20px 16px; font-size: 14px; line-height: 1.66; color: var(--ink-2); }
.fc-summary::before { content: ""; display: block; height: 1px; margin: 0 0 16px; background: linear-gradient(90deg, var(--hair), transparent); }

.fc-claims { padding: 2px 20px 8px; }
.fc-claim { padding: 14px 0; border-top: 1px solid var(--hair-2); }
.fc-claim:first-child { border-top: none; }
.fc-claim-row { display: flex; align-items: baseline; gap: 13px; }
.fc-no { font-family: var(--mono); font-size: 11px; color: var(--ink-3); flex: none; padding-top: 2px; }
.fc-ctext { flex: 1; font-size: 14.5px; line-height: 1.5; }
.fc-tag {
  flex: none; display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; padding: 3px 10px; border-radius: 999px; font-weight: 500; white-space: nowrap;
  color: var(--vc); border: 1px solid color-mix(in srgb, var(--vc) 35%, transparent);
  background: color-mix(in srgb, var(--vc) 12%, transparent);
}
.fc-tag .pct { font-family: var(--mono); font-size: 10.5px; opacity: .8; }

.fc-ev { margin: 11px 0 0 24px; display: grid; gap: 9px; }
.fc-ev-item { padding-left: 13px; border-left: 2px solid var(--sc); }
.fc-ev-h { font-size: 12.5px; }
.fc-ev-h .st { font-family: var(--mono); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--sc); margin-right: 7px; }
.fc-ev-h a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--ink-3); }
.fc-ev-h a:hover { border-bottom-color: var(--ink); }
.fc-ev-h .ar { color: var(--ink-3); }
.fc-ev-s { font-size: 12px; line-height: 1.55; color: var(--ink-3); margin-top: 4px; }
.fc-concern { margin: 10px 0 0 24px; font-size: 12px; color: var(--ink-3); }
.fc-concern .mk { color: ${VERDICT_COLOR.mixed}; }

.fc-foot {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 20px; margin-top: 4px; border-top: 1px solid var(--hair-2);
  font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3);
}
.fc-foot .dots { color: color-mix(in srgb, var(--accent) 70%, var(--ink-3)); }

/* 骨架 / 加载 */
.fc-skel { height: 11px; border-radius: 3px; background: var(--hair); animation: fcpulse 1.3s ease-in-out infinite; }
.fc-skel.short { width: 38%; }
@keyframes fcpulse { 0%,100% { opacity: .35; } 50% { opacity: .85; } }
.gauge.loading .center .n { color: var(--ink-3); animation: fcpulse 1.3s ease-in-out infinite; }

/* 入场 / 逐条落定 */
.fc-claim.resolve { animation: fcClaimIn .42s cubic-bezier(.2,.7,.2,1) both; }
.fc-claim.resolve .fc-tag { animation: fcTagPop .42s .06s cubic-bezier(.2,1.3,.4,1) both; }
@keyframes fcCardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes fcClaimIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fcTagPop { from { opacity: 0; transform: scale(.82); } to { opacity: 1; transform: none; } }

/* 错误态 */
.fc.error { border-color: ${VERDICT_COLOR.false}; }
.fc .fc-err { padding: 16px 20px; color: ${VERDICT_COLOR.false}; font-size: 13px; }

@media (prefers-reduced-motion: reduce) {
  .fc-glow, .fc-edge, .fc-verdict, .gauge .val, .fc-mast .brand .mark { transition: none; }
  .fc-skel, .gauge.loading .center .n,
  .fc-wrap, .fc-claim.resolve, .fc-claim.resolve .fc-tag { animation: none; }
}
`;

function gaugeSVG(value: number): string {
  const dash = (Math.max(0, Math.min(1, value)) * RING_C).toFixed(1);
  return (
    `<svg width="112" height="112" viewBox="0 0 112 112">` +
    `<circle class="track" cx="56" cy="56" r="50"></circle>` +
    `<circle class="val" cx="56" cy="56" r="50" stroke-dasharray="${dash} ${RING_C.toFixed(2)}"></circle>` +
    `</svg>`
  );
}

function gaugeCenter(label: string, sup = ""): HTMLElement {
  const c = document.createElement("div");
  c.className = "center";
  const n = document.createElement("div");
  n.className = "n";
  n.textContent = label;
  if (sup) {
    const s = document.createElement("sup");
    s.textContent = sup;
    n.appendChild(s);
  }
  const l = document.createElement("div");
  l.className = "lbl";
  l.textContent = "可信度";
  c.append(n, l);
  return c;
}

function buildClaimRow(cr: ClaimResult): HTMLElement {
  const claim = document.createElement("div");
  claim.className = "fc-claim";

  const row = document.createElement("div");
  row.className = "fc-claim-row";
  const no = document.createElement("span");
  no.className = "fc-no";
  no.textContent = cr.claim.id.replace(/^c/, "").padStart(2, "0");
  const text = document.createElement("span");
  text.className = "fc-ctext";
  text.textContent = cr.claim.text;
  const tag = document.createElement("span");
  tag.className = "fc-tag";
  tag.style.setProperty("--vc", VERDICT_COLOR[cr.final_verdict]);
  tag.textContent = VERDICT_LABEL[cr.final_verdict];
  const p = document.createElement("span");
  p.className = "pct";
  p.textContent = `${pct(cr.final_confidence)}%`;
  tag.appendChild(p);
  row.append(no, text, tag);
  claim.appendChild(row);

  if (cr.evaluation.evidence.length > 0) {
    const ev = document.createElement("div");
    ev.className = "fc-ev";
    for (const e of cr.evaluation.evidence) {
      const item = document.createElement("div");
      item.className = "fc-ev-item";
      item.style.setProperty("--sc", VERDICT_COLOR[e.stance === "refutes" ? "false" : e.stance === "supports" ? "true" : "unverifiable"]);
      const h = document.createElement("div");
      h.className = "fc-ev-h";
      const st = document.createElement("span");
      st.className = "st";
      st.textContent = STANCE_LABEL[e.stance];
      const a = document.createElement("a");
      a.href = e.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = e.title || e.source_url;
      const ar = document.createElement("span");
      ar.className = "ar";
      ar.textContent = " ↗";
      h.append(st, a, ar);
      const s = document.createElement("div");
      s.className = "fc-ev-s";
      s.textContent = e.snippet;
      item.append(h, s);
      ev.appendChild(item);
    }
    claim.appendChild(ev);
  }

  // 复核质疑（critic 不认可，或留有 concerns）
  if (!cr.critique.approved || cr.critique.concerns.length > 0) {
    const cc = document.createElement("div");
    cc.className = "fc-concern";
    const mk = document.createElement("span");
    mk.className = "mk";
    mk.textContent = "◆ 复核";
    cc.append(mk, document.createTextNode(" " + (cr.critique.concerns[0] || "复核已通过")));
    claim.appendChild(cc);
  }

  return claim;
}

function buildSkeletonRow(claim: Claim): HTMLElement {
  const el = document.createElement("div");
  el.className = "fc-claim";
  const row = document.createElement("div");
  row.className = "fc-claim-row";
  const no = document.createElement("span");
  no.className = "fc-no";
  no.textContent = claim.id.replace(/^c/, "").padStart(2, "0");
  const text = document.createElement("span");
  text.className = "fc-ctext";
  text.textContent = claim.text;
  const skel = document.createElement("span");
  skel.className = "fc-skel short";
  skel.style.width = "64px";
  row.append(no, text, skel);
  el.appendChild(row);
  return el;
}

/** 流式核查卡：挂 Shadow DOM，加载→骨架→逐条填→最终态。*/
export class FactCard {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly wrap: HTMLElement;
  private readonly fc: HTMLElement;
  private readonly gauge: HTMLElement;
  private readonly verdict: HTMLElement;
  private readonly verdictEn: HTMLElement;
  private readonly note: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly claimsBox: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  constructor(anchor: HTMLElement) {
    anchor.querySelectorAll(`:scope > .${HOST_CLASS}`).forEach((n) => n.remove());

    this.host = document.createElement("div");
    this.host.className = HOST_CLASS;
    this.host.setAttribute("data-theme", detectTheme());
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    this.root.appendChild(style);

    // 卡片骨架
    this.wrap = document.createElement("div");
    this.wrap.className = "fc-wrap";
    const glow = document.createElement("div");
    glow.className = "fc-glow";
    this.fc = document.createElement("div");
    this.fc.className = "fc";

    const edge = document.createElement("div");
    edge.className = "fc-edge";

    const mast = document.createElement("div");
    mast.className = "fc-mast";
    mast.innerHTML =
      `<div class="brand"><span class="mark">◇</span><b>FACTCHECK</b><span class="sub">/ 事实核查</span></div>`;
    const metaSpan = document.createElement("div");
    metaSpan.className = "meta";
    mast.appendChild(metaSpan);
    this.foot = document.createElement("div");

    const hero = document.createElement("div");
    hero.className = "fc-hero";
    this.gauge = document.createElement("div");
    this.gauge.className = "gauge loading";
    this.gauge.innerHTML = gaugeSVG(0);
    this.gauge.appendChild(gaugeCenter("···"));
    const heroText = document.createElement("div");
    heroText.className = "fc-hero-text";
    this.verdict = document.createElement("div");
    this.verdict.className = "fc-verdict";
    this.verdict.textContent = "核查中";
    this.verdictEn = document.createElement("div");
    this.verdictEn.className = "fc-verdict-en";
    this.verdictEn.textContent = "Analyzing";
    this.note = document.createElement("div");
    this.note.className = "fc-verdict-note";
    this.note.textContent = "正在抽取断言…";
    heroText.append(this.verdict, this.verdictEn, this.note);
    hero.append(this.gauge, heroText);

    this.summary = document.createElement("div");
    this.summary.className = "fc-summary";
    this.summary.style.display = "none";

    this.claimsBox = document.createElement("div");
    this.claimsBox.className = "fc-claims";

    this.fc.append(edge, mast, hero, this.summary, this.claimsBox);
    this.wrap.append(glow, this.fc);
    this.root.appendChild(this.wrap);
    anchor.appendChild(this.host);

    this.timing = metaSpan;
  }

  private readonly timing: HTMLElement;

  setClaims(claims: Claim[]): void {
    this.note.textContent = claims.length
      ? `核查 ${claims.length} 条断言…`
      : "未发现可核查断言。";
    this.claimsBox.replaceChildren();
    this.rows.clear();
    for (const c of claims) {
      const row = buildSkeletonRow(c);
      this.rows.set(c.id, row);
      this.claimsBox.appendChild(row);
    }
  }

  resolveClaim(cr: ClaimResult): void {
    const filled = buildClaimRow(cr);
    filled.classList.add("resolve"); // 落定动效（reduced-motion 下自动停用）
    const row = this.rows.get(cr.claim.id);
    if (row) row.replaceWith(filled);
    else this.claimsBox.appendChild(filled);
    this.rows.set(cr.claim.id, filled);
  }

  finalize(result: FactCheckResult): void {
    const v = result.overall_verdict;
    const color = VERDICT_COLOR[v];
    this.wrap.style.setProperty("--accent", color);

    // 仪表弧描边 + 可信分 count-up（招牌时刻）
    const conf = result.overall_confidence;
    const target = pct(conf);
    const reduced = prefersReduced();
    this.gauge.className = "gauge";
    this.gauge.innerHTML = gaugeSVG(reduced ? conf : 0);
    const center = gaugeCenter(reduced ? String(target) : "0", "%");
    this.gauge.appendChild(center);
    if (!reduced) {
      const val = this.gauge.querySelector(".val");
      const numNode = center.querySelector(".n")?.firstChild ?? null;
      tween(820, (e) => {
        if (val)
          val.setAttribute(
            "stroke-dasharray",
            `${(conf * e * RING_C).toFixed(1)} ${RING_C.toFixed(2)}`
          );
        if (numNode) numNode.textContent = String(Math.round(target * e));
      });
    }

    this.verdict.textContent = VERDICT_LABEL[v];
    this.verdictEn.textContent = VERDICT_EN[v];
    this.note.innerHTML = "";
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.textContent = "▾ ";
    this.note.append(bar, document.createTextNode(`综合 ${result.claims.length} 条断言`));

    if (result.summary) {
      this.summary.textContent = result.summary;
      this.summary.style.display = "";
    }

    const secs = ((result.processing_ms ?? 0) / 1000).toFixed(1);
    this.timing.textContent = `◷ ${secs}s`;

    // 脚注：模型 + 来源数 + 耗时（边界兜底，防 mock/异常数据缺字段）
    const evCount = result.claims.reduce(
      (n, c) => n + (c.evaluation.evidence?.length ?? 0),
      0
    );
    this.foot.className = "fc-foot";
    const models = Object.values(result.model_versions ?? {});
    const left = document.createElement("span");
    left.innerHTML = `<span class="dots">●</span> `;
    left.append(document.createTextNode(models.length ? models.join(" · ") : "—"));
    const right = document.createElement("span");
    right.textContent = `来源 ${evCount} · ${secs}s`;
    this.foot.replaceChildren(left, right);
    if (!this.foot.parentElement) this.fc.appendChild(this.foot);
  }

  error(err: unknown): void {
    this.wrap.style.setProperty("--accent", VERDICT_COLOR.false);
    this.fc.classList.add("error");
    const msg = document.createElement("div");
    msg.className = "fc-err";
    msg.textContent = `核查失败：${err instanceof Error ? err.message : String(err)}`;
    this.fc.replaceChildren(msg);
  }
}
