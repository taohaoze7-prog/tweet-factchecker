// 与后端 contracts/models.py 一一对应的 TS 镜像。
// **冻结点**：改动需与 backend/contracts 同步，否则前后端契约漂移。

export type Verdict =
  | "true"
  | "mostly_true"
  | "mixed"
  | "mostly_false"
  | "false"
  | "unverifiable";

export type Stance = "supports" | "refutes" | "neutral";

// extension → backend
export interface FactCheckRequest {
  tweet_id: string;
  text: string;
  author_handle?: string | null;
  url?: string | null;
  lang?: string | null;
}

export interface Claim {
  id: string;
  text: string;
  checkable: boolean;
}

export interface Evidence {
  source_url: string;
  title?: string | null;
  snippet: string;
  stance: Stance;
  score: number;
}

export interface Evaluation {
  claim_id: string;
  verdict: Verdict;
  confidence: number;
  evidence: Evidence[];
  reasoning: string;
}

export interface Critique {
  claim_id: string;
  approved: boolean;
  adjusted_verdict?: Verdict | null;
  adjusted_confidence?: number | null;
  concerns: string[];
}

export interface ClaimResult {
  claim: Claim;
  evaluation: Evaluation;
  critique: Critique;
  final_verdict: Verdict;
  final_confidence: number;
}

// backend → extension
export interface FactCheckResult {
  tweet_id: string;
  overall_verdict: Verdict;
  overall_confidence: number;
  summary: string;
  claims: ClaimResult[];
  processing_ms: number;
  model_versions: Record<string, string>;
}
