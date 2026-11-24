/** Shared types of the prompt pipeline. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /**
   * Constrains the answer to JSON. An object is a JSON schema; `"json"` means "any JSON".
   * Omit for free text.
   */
  schema?: object | "json";
  signal?: AbortSignal;
  /** Called with each piece of text as it streams in (optional; structured stages do not stream). */
  onToken?: (token: string) => void;
}

/** What the pipeline needs from a language model. */
export interface LlmClient {
  chat(request: ChatRequest): Promise<string>;
}

/** The language model could not be reached or refused the request (not a bad answer). */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface Attachment {
  name: string;
  /** Short type label shown to the user, e.g. "pdf", "csv", "pasted text". */
  type: string;
  /** The first characters of its text, only used to infer the domain. Never rewritten. */
  preview?: string;
}

/** An item the model claims the user said, with the words that prove it. */
export interface EvidencedText {
  text: string;
  evidence: string;
}

/** What Stage 2 (Analyze) returns, before validation. */
export interface Analysis {
  task_type: string;
  task: string;
  role: { value: string; evidence: string } | null;
  context: EvidencedText[];
  constraints: EvidencedText[];
  output_format: EvidencedText | null;
  missing_info: string[];
}

/** The same, after the validator removed everything it could not prove. */
export interface ValidAnalysis {
  task_type: string;
  task: string;
  role: string | null;
  context: string[];
  constraints: string[];
  output_format: string | null;
  missing_info: string[];
}

export type DropReason = "no-evidence" | "evidence-not-in-transcript" | "invented-number";

export interface DroppedItem {
  field: "role" | "task" | "context" | "constraints" | "output_format";
  text: string;
  reason: DropReason;
}

export interface DroppedReport {
  count: number;
  items: DroppedItem[];
}

export type StageName = "normalize" | "analyze" | "render";

export interface PipelineResult {
  /** The finished prompt text. */
  prompt: string;
  /** True when the model's answers could not be used and a minimal prompt was produced instead. */
  degraded: boolean;
  /** The transcript after the deterministic filler removal (Stage 0). */
  stage0_text: string;
  /** The cleaned text from Stage 1 (equals `stage0_text` if Stage 1 failed). */
  clean_text: string;
  /** The validated analysis, or null when the minimal prompt was used. */
  analysis: ValidAnalysis | null;
  dropped: DroppedReport;
  /** Short, user-safe remarks (e.g. why a stage fell back). Never contains the transcript. */
  warnings: string[];
}
