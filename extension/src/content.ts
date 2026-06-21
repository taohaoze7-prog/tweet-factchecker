// Content script：抓推文 + 注入"核查"按钮 + 触发浮层。
// frontend worktree 的主战场。

import { factCheckStream, IS_MOCK, BACKEND } from "./api";
import { FactCard } from "./overlay";
import type { FactCheckRequest } from "./types";

const BUTTON_CLASS = "fc-check-btn";
const PROCESSED_ATTR = "data-fc-processed";

// 实战调试期诊断开关：开发者工具 Console 可见注入情况。稳定后置 false。
const DEBUG = true;
const log = (...a: unknown[]): void => {
  if (DEBUG) console.info("[factchecker]", ...a);
};

/** 从 X/Twitter status 链接里解析 tweet_id（/<user>/status/<id>）。*/
function extractTweetId(article: HTMLElement): string | null {
  const links = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
  for (const a of links) {
    const m = a.getAttribute("href")?.match(/\/status\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** 解析作者 handle（@xxx）。*/
function extractAuthorHandle(article: HTMLElement): string | null {
  const link = article.querySelector<HTMLAnchorElement>('a[href^="/"][role="link"]');
  const href = link?.getAttribute("href");
  // 形如 "/elonmusk"，排除 /status、/i 等系统路径。
  if (href && /^\/[A-Za-z0-9_]+$/.test(href)) {
    return `@${href.slice(1)}`;
  }
  return null;
}

/** 从一个推文 DOM 节点抽取 FactCheckRequest。*/
function extractTweet(article: HTMLElement): FactCheckRequest | null {
  // X/Twitter 正文容器：data-testid="tweetText"。退化时回落到 innerText。
  const textNode = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const text = (textNode?.innerText ?? article.innerText ?? "").trim();
  if (!text) return null;

  const tweetId = extractTweetId(article) ?? crypto.randomUUID();
  const handle = extractAuthorHandle(article);
  return {
    tweet_id: tweetId,
    text,
    author_handle: handle,
    url: extractTweetId(article)
      ? `https://x.com/i/status/${tweetId}`
      : null,
    lang: textNode?.getAttribute("lang") ?? null,
  };
}

/** 找推文动作栏（点赞/转发那一排）作为按钮锚点，找不到则回落到 article。*/
function findActionBar(article: HTMLElement): HTMLElement {
  return (
    article.querySelector<HTMLElement>('[role="group"]') ?? article
  );
}

/** 行内样式按钮（不依赖全局样式表，杜绝污染 X）。*/
function styleButton(btn: HTMLButtonElement): void {
  const s = btn.style;
  s.cursor = "pointer";
  s.border = "1px solid rgba(63,224,138,0.35)";
  s.background = "rgba(63,224,138,0.08)";
  s.color = "#3fe08a";
  s.borderRadius = "999px";
  s.padding = "2px 12px";
  s.fontSize = "13px";
  s.fontWeight = "600";
  s.marginLeft = "8px";
  s.lineHeight = "1.5";
  s.fontFamily = "-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
  s.transition = "background .15s ease";
  btn.onmouseenter = () => (s.background = "rgba(63,224,138,0.16)");
  btn.onmouseleave = () => (s.background = "rgba(63,224,138,0.08)");
}

/** 给一个推文节点注入核查按钮。*/
function injectButton(article: HTMLElement): void {
  if (article.querySelector(`.${BUTTON_CLASS}`)) return; // 防重复注入

  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.type = "button";
  btn.textContent = "✓ 核查";
  styleButton(btn);
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const req = extractTweet(article);
    if (!req) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";
    btn.textContent = "核查中…";
    const card = new FactCard(article);
    try {
      // 渐进消费：claims 出骨架 → 每条 claim 填行 → done 换最终卡片。
      for await (const event of factCheckStream(req)) {
        if (event.type === "claims") card.setClaims(event.claims);
        else if (event.type === "claim") card.resolveClaim(event.result);
        else if (event.type === "done") card.finalize(event.result);
        else if (event.type === "error") throw new Error(event.message);
      }
      btn.textContent = "✓ 已核查";
      btn.style.opacity = "1";
    } catch (err) {
      console.error("[factchecker]", err);
      card.error(err);
      btn.textContent = "✗ 重试";
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  });

  findActionBar(article).appendChild(btn);
}

/** 扫描当前 DOM 里所有未处理的推文并注入按钮。*/
function scan(): void {
  const fresh = document.querySelectorAll<HTMLElement>(
    'article:not([' + PROCESSED_ATTR + "])"
  );
  let injected = 0;
  fresh.forEach((article) => {
    article.setAttribute(PROCESSED_ATTR, "1");
    const before = article.querySelector(`.${BUTTON_CLASS}`);
    injectButton(article);
    if (!before && article.querySelector(`.${BUTTON_CLASS}`)) injected++;
  });
  if (fresh.length) log(`扫描 ${fresh.length} 条推文，注入按钮 ${injected} 个`);
}

/** 监听时间线动态加载，对新出现的推文注入按钮。*/
function observe(): void {
  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan(); // 首屏已渲染的推文
}

log(
  `content script 已加载 · 模式=${IS_MOCK ? "MOCK(假数据)" : "REAL→" + BACKEND} · 开始监听`
);
observe();
