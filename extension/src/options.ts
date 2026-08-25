// 设置页逻辑：Key 的验证、保存、清除。
//
// 保存前先打一次最小请求验证 Key 可用——让用户当场知道对不对，
// 而不是等第一次核查失败才发现（那时已经浪费了一次交互，还看不清是谁的错）。

import { validateKey, AnthropicError } from "./engine/anthropic";
import {
  clearApiKey,
  getApiKey,
  looksLikeAnthropicKey,
  maskKey,
  setApiKey,
} from "./settings";

// GitHub Pages（仓库 Settings → Pages → Source: main /docs）。
// 商店审核会实际访问这个地址，上架前必须确认可打开。
const PRIVACY_URL =
  "https://taohaoze7-prog.github.io/tweet-factchecker/privacy.html";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const input = $<HTMLInputElement>("key");
const saveBtn = $<HTMLButtonElement>("save");
const clearBtn = $<HTMLButtonElement>("clear");
const toggleBtn = $<HTMLButtonElement>("toggle");
const status = $<HTMLParagraphElement>("status");
const privacyLink = $<HTMLAnchorElement>("privacy");

function setStatus(text: string, kind: "ok" | "err" | "busy" | "" = "") {
  status.textContent = text;
  status.className = kind ? `status ${kind}` : "status";
}

/** 已存 Key 时用打码占位，不把完整凭证回填进 DOM。*/
async function restore() {
  privacyLink.href = PRIVACY_URL;
  const saved = await getApiKey();
  if (saved) {
    input.placeholder = maskKey(saved);
    setStatus("已保存一枚密钥。重新输入可覆盖。", "ok");
  }
}

toggleBtn.addEventListener("click", () => {
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  toggleBtn.textContent = show ? "隐藏" : "显示";
});

saveBtn.addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key) {
    setStatus("请先填入 API Key。", "err");
    return;
  }
  if (!looksLikeAnthropicKey(key)) {
    setStatus("这不像一枚 Anthropic 密钥（应以 sk-ant- 开头）。", "err");
    return;
  }

  saveBtn.disabled = true;
  clearBtn.disabled = true;
  setStatus("正在验证…", "busy");

  try {
    await validateKey(key);
    await setApiKey(key);
    input.value = "";
    input.placeholder = maskKey(key);
    setStatus("验证通过，已保存。现在可以到 x.com 使用了。", "ok");
  } catch (e) {
    const msg =
      e instanceof AnthropicError ? e.message : "验证失败，请检查密钥与网络。";
    setStatus(msg, "err");
  } finally {
    saveBtn.disabled = false;
    clearBtn.disabled = false;
  }
});

clearBtn.addEventListener("click", async () => {
  await clearApiKey();
  input.value = "";
  input.placeholder = "sk-ant-...";
  setStatus("已清除本机保存的密钥。", "ok");
});

// 回车即提交，省一次鼠标移动。
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

void restore();
