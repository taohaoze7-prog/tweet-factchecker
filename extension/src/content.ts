// Content script：抓推文 + 注入"核查"按钮 + 触发浮层。
// frontend worktree 的主战场。以下为骨架，标出抓取/注入的接入点。

import { factCheck } from "./api";
import { renderOverlay } from "./overlay";
import type { FactCheckRequest } from "./types";

const BUTTON_CLASS = "fc-check-btn";

/** 从一个推文 DOM 节点抽取 FactCheckRequest。*/
function extractTweet(article: HTMLElement): FactCheckRequest | null {
  // TODO(frontend): 解析 X/Twitter 的 article 结构，取 tweet_id / text / author / url。
  const text = article.innerText?.trim();
  if (!text) return null;
  return {
    tweet_id: article.getAttribute("data-tweet-id") ?? crypto.randomUUID(),
    text,
  };
}

/** 给一个推文节点注入核查按钮。*/
function injectButton(article: HTMLElement): void {
  if (article.querySelector(`.${BUTTON_CLASS}`)) return; // 防重复注入
  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.textContent = "✓ 核查";
  btn.addEventListener("click", async () => {
    const req = extractTweet(article);
    if (!req) return;
    btn.disabled = true;
    btn.textContent = "核查中…";
    try {
      const result = await factCheck(req);
      renderOverlay(article, result);
    } catch (e) {
      console.error("[factchecker]", e);
      btn.textContent = "✗ 失败";
    } finally {
      btn.disabled = false;
    }
  });
  article.appendChild(btn);
}

/** 监听时间线动态加载，对新出现的推文注入按钮。*/
function observe(): void {
  // TODO(frontend): 用 MutationObserver 监听 timeline，对每个 article 调 injectButton。
  const observer = new MutationObserver(() => {
    document
      .querySelectorAll<HTMLElement>("article")
      .forEach((a) => injectButton(a));
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

observe();
