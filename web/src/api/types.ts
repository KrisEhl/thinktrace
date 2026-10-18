// UI-side event model. The mock speaks it natively; the real backend's envelope events
// (docs/agent-and-event-logging.md section 4) are translated into it by api/glassbox.ts.

export type NodeKind = "question" | "dimension" | "direction";
export type NodeStatus = "idle" | "running" | "done" | "deactivated" | "stale";
export type Verdict = "yes" | "no" | "uncertain";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  parent_id: string | null;
  label: string;
  status: NodeStatus;
  verdict?: Verdict;
  confidence?: number; // 0..1, backend-computed (deterministic rule in spec)
  needs_human?: boolean;
  traffic: number; // searches + reads
  /** Real backend: full direction title, the plan's reason, and its first queries. */
  title?: string;
  why?: string;
  queries?: string[];
  /** Real backend stop reason, drives the stop badge. */
  stop?: StopReason;
  budget_hit?: boolean;
  /** Redirect: the dropped direction this one replaced. */
  from_dir?: string;
}

export type StopReason = "enough_evidence" | "nothing_new" | "budget" | "dropped_by_user" | "no_reason";

export interface Assumption {
  id: string;
  text: string;
  fixed_by_user: boolean;
}

export interface Source {
  id: string;
  url: string;
  title: string;
  domain: string;
  origin_id: string; // reprints collapse to the same origin
  text: string; // extracted source text (what quotes are verified against)
  origin: "web" | "user_doc";
}

export interface Claim {
  id: string;
  node_id: string;
  text: string;
  quote: string;
  source_id: string;
  span: [number, number] | null; // char offsets in Source.text, null while unverified
  verified: boolean | null; // null = not checked yet
  confidence: number;
  origin_ids: string[]; // independent origins backing this claim
  /** Real backend: how the quote was found ("snippet" = only checked against a search snippet, no span). */
  match?: "exact" | "fuzzy" | "not_found";
  verified_against?: "full_text" | "snippet";
  links?: ClaimLink[];
}

export interface ClaimLink {
  relation: "corroborates" | "contradicts";
  target: string;
  by: "agent" | "checker";
  reason?: string;
}

export interface Decision {
  id: string;
  node_id: string;
  action: "search" | "read" | "stop";
  why: string;
  query?: string;
  source_id?: string;
  /** Search decisions: the sources the search returned. */
  results?: string[];
  /** The model's reflection text from `think`, when it gave one. */
  reflection?: string;
  ts: number;
}

export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  node_id: string; // the node this message is pinned to (root if none was selected)
  claim_ids?: string[];
  pending?: boolean;
}

export interface AnswerSentence {
  text: string;
  claim_ids: string[];
}

export interface Cost {
  sources: number;
  steers: number;
  restarts: number;
  eur: number;
}

export interface GraphSnapshot {
  run_id: string;
  question: string;
  status: "running" | "finished" | "error";
  assumptions: Assumption[];
  nodes: GraphNode[];
  sources: Source[];
  claims: Claim[];
  decisions: Decision[];
  messages: Message[];
  answer: AnswerSentence[];
  cost: Cost;
}

export type GlassboxEvent =
  | { type: "run_started"; run_id: string; question: string }
  | { type: "run_finished" }
  | { type: "error"; message: string }
  | { type: "assumption_created"; assumption: Assumption }
  | { type: "direction_created"; node: GraphNode }
  | { type: "source_added"; source: Source }
  | { type: "claim_added"; claim: Claim }
  | { type: "claim_verified"; claim_id: string; verified: boolean; span: [number, number] | null }
  | { type: "confidence_changed"; node_id?: string; claim_id?: string; confidence: number; origin_ids?: string[] }
  | { type: "verdict_set"; node_id: string; verdict: Verdict }
  | { type: "decision"; decision: Decision }
  | { type: "direction_stopped"; node_id: string; reason: string }
  | { type: "steer_applied"; action: SteerAction; node_id?: string; text?: string }
  | { type: "stale_marked"; node_ids: string[] }
  | { type: "needs_human"; node_id: string; reason: string }
  | { type: "message"; message: Message }
  | { type: "answer_updated"; answer: AnswerSentence[]; version?: number; changed?: string[]; dropped?: string[] }
  | { type: "node_patch"; node_id: string; patch: Partial<GraphNode> }
  | { type: "cost_updated"; cost: Cost };

export type SteerAction = "deactivate" | "redirect" | "dig_deeper" | "fix" | "accept" | "chat";

export interface SteerRequest {
  action: SteerAction;
  node_id?: string;
  text?: string;
}

export interface CreateRunRequest {
  question: string;
  context_text?: string;
  /** Mock backend only: which canned scenario to play. Ignored by the real backend. */
  scenario?: string;
}

/** Mock backend only: poke the graph to try out the UI. */
export type SimOp = "add_branch" | "add_evidence" | "contradict" | "mark_stale" | "needs_you" | "skip_to_end";

/**
 * The only surface the UI talks to. HttpTransport (real backend) and MockTransport (in-browser replay)
 * both implement it, so wiring the backend later is a one-line switch in api/index.ts.
 */
export interface Transport {
  createRun(req: CreateRunRequest): Promise<{ run_id: string }>;
  /** Live events for a run. Returns an unsubscribe function. */
  subscribe(run_id: string, onEvent: (e: GlassboxEvent) => void, onClose?: () => void): () => void;
  getGraph?(run_id: string): Promise<GraphSnapshot>;
  steer(run_id: string, req: SteerRequest): Promise<void>;
  getSource(source_id: string): Promise<Source>;
  health(): Promise<{ ok: boolean; models?: string[]; tavily?: boolean; mode?: string }>;
  /** Runs the backend knows about (live and recorded). */
  listRuns?(): Promise<RunInfo[]>;
  /** Present on the mock only. */
  simulate?(op: SimOp, node_id?: string, text?: string): void;
  scenarios?: { id: string; label: string; question: string }[];
}

export interface RunInfo {
  run_id: string;
  question: string;
  status: string;
  started_at?: string;
}
