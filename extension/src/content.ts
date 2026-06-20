// Content script：抓推文 + 注入"核查"按钮 + 触发浮层。
// frontend worktree 的主战场。

import { factCheck } from "./api";
import { injectStyles, renderOverlay, renderError } from "./overlay";
import type { FactCheckRequest } from "./types";

const BUTTON_CLASS = "fc-check-btn";
const PROCESSED_ATTR = "data-fc-processed";

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

/** 给一个推文节点注入核查按钮。*/
function injectButton(article: HTMLElement): void {
  if (article.querySelector(`.${BUTTON_CLASS}`)) return; // 防重复注入

  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.type = "button";
  btn.textContent = "✓ 核查";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const req = extractTweet(article);
    if (!req) return;
    btn.disabled = true;
    btn.textContent = "核查中…";
    try {
      const result = await factCheck(req);
      renderOverlay(article, result);
      btn.textContent = "✓ 已核查";
    } catch (err) {
      console.error("[factchecker]", err);
      renderError(article, err);
      btn.textContent = "✗ 重试";
      btn.disabled = false;
    }
  });

  findActionBar(article).appendChild(btn);
}

/** 扫描当前 DOM 里所有未处理的推文并注入按钮。*/
function scan(): void {
  document
    .querySelectorAll<HTMLElement>('article:not([' + PROCESSED_ATTR + "])")
    .forEach((article) => {
      article.setAttribute(PROCESSED_ATTR, "1");
      injectButton(article);
    });
}

/** 监听时间线动态加载，对新出现的推文注入按钮。*/
function observe(): void {
  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan(); // 首屏已渲染的推文
}

injectStyles();
observe();
