// 引擎冒烟：在 Node 里跑完整核查管道，验证移植正确性。
//
// 只测 engine/（纯 fetch，无 chrome API 依赖），不测 content/background 的
// 浏览器接线——那部分要靠真 X 手测。
//
// 跑法：ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/smoke.ts

import { checkStream } from "../src/engine/pipeline";
import { extractClaims } from "../src/engine/claim";
import { aggregate, resolveClaim, degradedResult } from "../src/engine/pipeline";
import type { Claim, Evaluation, Critique } from "../src/types";

const KEY = process.env.ANTHROPIC_API_KEY ?? "";
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- 1. 纯函数：聚合与收敛逻辑（不花钱，先跑）----

function testPureLogic(): void {
  console.log("\n[1] 纯逻辑（离线）");

  const claim: Claim = { id: "c1", text: "测试断言", checkable: true };
  const evaluation: Evaluation = {
    claim_id: "c1",
    verdict: "mostly_true",
    confidence: 0.8,
    evidence: [],
    reasoning: "r",
  };

  // critic 认可 → 沿用初判
  const approved: Critique = {
    claim_id: "c1",
    approved: true,
    adjusted_verdict: null,
    adjusted_confidence: null,
    concerns: [],
  };
  const r1 = resolveClaim(claim, evaluation, approved);
  check("critic 认可时沿用初判", r1.final_verdict === "mostly_true" && r1.final_confidence === 0.8);

  // critic 不认可 → 采用修正值
  const rejected: Critique = {
    claim_id: "c1",
    approved: false,
    adjusted_verdict: "mixed",
    adjusted_confidence: 0.4,
    concerns: ["单一来源"],
  };
  const r2 = resolveClaim(claim, evaluation, rejected);
  check("critic 否决时采用修正判定", r2.final_verdict === "mixed" && r2.final_confidence === 0.4);

  // 聚合：全 unverifiable
  const agg1 = aggregate([degradedResult(claim, "超时")]);
  check(
    "全部无法核实 → 整体 unverifiable",
    agg1.verdict === "unverifiable" && agg1.summary.includes("均无法核实"),
  );

  // 聚合：空列表
  const agg2 = aggregate([]);
  check("无断言 → 专属话术", agg2.summary === "无可核查的事实性断言。");

  // 聚合：混合，且必须披露未核实条数
  const agg3 = aggregate([r1, degradedResult({ id: "c2", text: "x", checkable: true }, "超时")]);
  check(
    "部分核实 → 结论里披露覆盖率",
    agg3.summary.includes("1 条已核实") && agg3.summary.includes("1 条无法核实"),
    agg3.summary,
  );
}

// ---- 2. 真链路：抽断言（便宜，Haiku 一次）----

async function testClaimExtraction(): Promise<void> {
  console.log("\n[2] 断言抽取（真实 Haiku 调用）");
  const ctrl = new AbortController();

  const factual = await extractClaims(
    KEY,
    "苹果公司在 2024 年第四季度营收达到 1243 亿美元，创下历史新高。",
    "zh",
    ctrl.signal,
  );
  check("事实性推文抽出断言", factual.length > 0, `${factual.length} 条`);
  check(
    "断言 id 稳定生成",
    factual.every((c, i) => c.id === `c${i + 1}`),
  );

  // 关键回归：非断言不得被硬造成 checkable 塞进昂贵管道
  const chatter = await extractClaims(KEY, "Great!! 😂😂", null, ctrl.signal);
  const chatterCheckable = chatter.filter((c) => c.checkable);
  check(
    "纯表态不产生可核查断言（不烧钱）",
    chatterCheckable.length === 0,
    `checkable=${chatterCheckable.length}`,
  );
}

// ---- 3. 真链路：端到端流式核查（贵，Sonnet + 联网）----

async function testEndToEnd(): Promise<void> {
  console.log("\n[3] 端到端流式核查（真实 Sonnet + 联网搜证）");
  const ctrl = new AbortController();
  const started = Date.now();

  const seen: string[] = [];
  let final = null;

  for await (const ev of checkStream(
    KEY,
    {
      tweet_id: "smoke-1",
      text: "地球是平的，NASA 承认了这一点。",
      lang: "zh",
    },
    ctrl.signal,
  )) {
    seen.push(ev.type);
    if (ev.type === "claims") {
      console.log(`    → claims: ${ev.claims.length} 条`);
    } else if (ev.type === "claim") {
      console.log(
        `    → claim ${ev.result.claim.id}: ${ev.result.final_verdict} (${ev.result.evaluation.evidence.length} 条证据)`,
      );
    } else {
      final = ev.result;
    }
  }

  check("事件序列以 claims 开头、done 结尾", seen[0] === "claims" && seen.at(-1) === "done");
  check("产出最终结果", final !== null);
  if (final) {
    check("整体判定倾向不实", ["false", "mostly_false"].includes(final.overall_verdict), final.overall_verdict);
    check("summary 非空", !!final.summary, final.summary);
    check("记录了模型版本", Object.keys(final.model_versions).length === 3);
    const withEvidence = final.claims.filter((c) => c.evaluation.evidence.length > 0);
    check("至少一条断言带可追溯来源", withEvidence.length > 0, `${withEvidence.length}/${final.claims.length}`);
    // 幻觉闸门：每条证据必须有真实 URL
    const badUrls = final.claims
      .flatMap((c) => c.evaluation.evidence)
      .filter((e) => !/^https?:\/\//.test(e.source_url));
    check("证据 URL 均为真实链接", badUrls.length === 0, `${badUrls.length} 条异常`);

    // 铁律：不许出现「有确定判定但零来源」——那是看着权威却无法核验的结论。
    const unbacked = final.claims.filter(
      (c) => c.final_verdict !== "unverifiable" && c.evaluation.evidence.length === 0,
    );
    check(
      "无「零证据却给出确定判定」的断言",
      unbacked.length === 0,
      unbacked.length ? `${unbacked.length} 条: ${unbacked.map((c) => c.final_verdict).join(",")}` : "",
    );
  }
  console.log(`    耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// ---- 4. 取消：确认能真正掐断（省钱路径）----

async function testAbort(): Promise<void> {
  console.log("\n[4] 中止在途请求");
  const ctrl = new AbortController();
  const gen = checkStream(
    KEY,
    { tweet_id: "smoke-2", text: "2026 年世界杯将在北美举办。", lang: "zh" },
    ctrl.signal,
  );
  // 拿到第一个事件后立刻取消
  await gen.next();
  ctrl.abort();
  try {
    await gen.next();
    check("取消后生成器停止", true);
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || ctrl.signal.aborted);
    check("取消后抛 AbortError", aborted, e instanceof Error ? e.name : String(e));
  }
}

async function main(): Promise<void> {
  testPureLogic();

  if (!KEY) {
    console.log("\n⚠️  未设置 ANTHROPIC_API_KEY，跳过真链路测试（[2][3][4]）");
  } else {
    await testClaimExtraction();
    await testEndToEnd();
    await testAbort();
  }

  console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
