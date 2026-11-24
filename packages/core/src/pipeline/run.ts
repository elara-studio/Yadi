import { throwIfAborted } from "./abort";
import { ParseError, parseAnalysis, parseNormalize } from "./parse";
import {
  ANALYZE_SCHEMA,
  NORMALIZE_SCHEMA,
  REPAIR_INSTRUCTION,
  analyzeMessages,
  normalizeMessages,
} from "./prompts";
import { renderMinimal, renderPrompt } from "./render";
import { stripFillers } from "./stage0";
import type {
  Attachment,
  ChatMessage,
  DroppedReport,
  LlmClient,
  PipelineResult,
  StageName,
  ValidAnalysis,
} from "./types";
import { validateAnalysis } from "./validate";

export interface RunOptions {
  transcript: string;
  attachments?: readonly Attachment[];
  /** Preferred spellings (names, jargon) for Stage 1. */
  vocabulary?: readonly string[];
  llm: LlmClient;
  /** Cancels the run: pending and later requests reject with an `AbortError`. */
  signal?: AbortSignal;
  /** Progress: "normalize" -> {clean_text}, "analyze" -> {analysis, dropped}, "render" -> {prompt}. */
  onStage?: (stage: StageName, data: unknown) => void;
}

export class EmptyTranscriptError extends Error {
  constructor() {
    super("There is nothing to process: the transcript is empty.");
    this.name = "EmptyTranscriptError";
  }
}

/** Stage 1 may not make the text much longer than it was: that would mean it added content. */
const MAX_GROWTH_RATIO = 1.3;
const MAX_GROWTH_EXTRA = 30;

type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * One structured call, with one repair retry when the answer is not usable JSON. Problems reaching
 * the model (`LlmError`) and cancellation are not retried: they propagate to the caller.
 */
async function structured<T>(
  llm: LlmClient,
  messages: ChatMessage[],
  schema: object,
  parse: (raw: string) => T,
  signal: AbortSignal | undefined,
): Promise<Attempt<T>> {
  throwIfAborted(signal);
  let raw = await llm.chat({ messages, schema, signal });
  try {
    return { ok: true, value: parse(raw) };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  throwIfAborted(signal);
  const repair: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: raw },
    { role: "user", content: REPAIR_INSTRUCTION },
  ];
  raw = await llm.chat({ messages: repair, schema, signal });
  try {
    return { ok: true, value: parse(raw) };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { ok: false, reason: e.message };
  }
}

const NO_DROPS: DroppedReport = { count: 0, items: [] };

export async function runPipeline(options: RunOptions): Promise<PipelineResult> {
  const { llm, signal, onStage } = options;
  const attachments = options.attachments ?? [];
  const warnings: string[] = [];

  throwIfAborted(signal);
  // Stage 0: deterministic
  const stage0 = stripFillers(options.transcript);
  if (stage0 === "") throw new EmptyTranscriptError();

  const degraded = (task: string, clean: string, why: string): PipelineResult => {
    warnings.push(why);
    const prompt = renderMinimal(task, attachments);
    onStage?.("render", { prompt });
    return {
      prompt,
      degraded: true,
      stage0_text: stage0,
      clean_text: clean,
      analysis: null,
      dropped: NO_DROPS,
      warnings,
    };
  };

  // Stage 1: normalize
  const normalized = await structured(
    llm,
    normalizeMessages(stage0, options.vocabulary ?? []),
    NORMALIZE_SCHEMA,
    parseNormalize,
    signal,
  );
  if (!normalized.ok) {
    return degraded(
      stage0,
      stage0,
      "The language model's cleanup answer could not be read, so a minimal prompt was made.",
    );
  }
  let clean = normalized.value.clean_text;
  if (clean.length > stage0.length * MAX_GROWTH_RATIO + MAX_GROWTH_EXTRA) {
    warnings.push("The cleanup added too much text, so the original wording was used.");
    clean = stage0;
  }
  onStage?.("normalize", { clean_text: clean });

  // Stage 2: analyze
  throwIfAborted(signal);
  const analyzed = await structured(
    llm,
    analyzeMessages(clean, attachments),
    ANALYZE_SCHEMA,
    parseAnalysis,
    signal,
  );
  if (!analyzed.ok) {
    return degraded(
      clean,
      clean,
      "The language model's analysis could not be read, so a minimal prompt was made.",
    );
  }

  // Validator (pure): drop everything that cannot be proven from what the person said
  const { analysis, dropped } = validateAnalysis(analyzed.value, {
    transcript: options.transcript,
    stage0,
    clean,
  });
  if (dropped.count > 0)
    warnings.push(
      `${dropped.count} detail(s) the model added could not be backed by your words and were left out.`,
    );
  onStage?.("analyze", { analysis, dropped });

  // Render (pure)
  throwIfAborted(signal);
  const prompt = renderPrompt(analysis satisfies ValidAnalysis, attachments);
  onStage?.("render", { prompt });
  return {
    prompt,
    degraded: false,
    stage0_text: stage0,
    clean_text: clean,
    analysis,
    dropped,
    warnings,
  };
}
