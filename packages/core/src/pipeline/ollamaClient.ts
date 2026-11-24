import { LlmError, type ChatRequest, type LlmClient } from "./types";

export const OLLAMA_BASE = "http://127.0.0.1:11434";

export interface OllamaClientOptions {
  /** Model tag, e.g. `qwen3:4b-instruct-2507-q4_K_M`. */
  model: string;
  /** Injected so the app can use the Tauri HTTP plugin's `fetch` and Node can use its own. */
  fetch: typeof fetch;
  baseUrl?: string;
  /** Low, so structured stages are repeatable. */
  temperature?: number;
  numCtx?: number;
  /** How long Ollama keeps the model loaded after a request. */
  keepAlive?: string;
}

/**
 * Talks to a local Ollama over HTTP (`POST /api/chat`).
 * Structured stages use `stream: false` with `format` set to a JSON schema; if Ollama rejects the
 * schema (HTTP 400) the request is repeated once with plain `format: "json"`.
 */
export class OllamaClient implements LlmClient {
  private readonly base: string;

  constructor(private readonly options: OllamaClientOptions) {
    this.base = (options.baseUrl ?? OLLAMA_BASE).replace(/\/+$/, "");
  }

  async chat(request: ChatRequest): Promise<string> {
    const streaming = request.onToken !== undefined;
    let res = await this.post(request, request.schema, streaming);
    if (res.status === 400 && request.schema !== undefined && request.schema !== "json") {
      // The model or this Ollama version could not use the schema: fall back to "any JSON".
      res = await this.post(request, "json", streaming);
    }
    if (!res.ok) {
      throw new LlmError(await errorText(res), res.status);
    }
    return streaming ? readStream(res, request.onToken) : readOnce(res);
  }

  private async post(
    request: ChatRequest,
    format: object | "json" | undefined,
    stream: boolean,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages,
      stream,
      think: false, // models with a thinking mode must answer directly
      options: {
        temperature: this.options.temperature ?? 0.1,
        num_ctx: this.options.numCtx ?? 4096,
      },
      keep_alive: this.options.keepAlive ?? "10m",
    };
    if (format !== undefined) body.format = format;
    try {
      return await this.options.fetch(`${this.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new LlmError(`Cannot reach Ollama: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  return text.trim() || `Ollama answered HTTP ${res.status}`;
}

async function readOnce(res: Response): Promise<string> {
  const parsed = (await res.json()) as { message?: { content?: unknown }; error?: unknown };
  if (typeof parsed.error === "string") throw new LlmError(parsed.error);
  const content = parsed.message?.content;
  if (typeof content !== "string") throw new LlmError("Ollama's answer had no message.");
  return content;
}

/** Reads newline-delimited JSON chunks, forwarding each piece of text. */
async function readStream(
  res: Response,
  onToken: ((t: string) => void) | undefined,
): Promise<string> {
  if (!res.body) return readOnce(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let full = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const parsed = JSON.parse(line) as { message?: { content?: string }; error?: string };
    if (typeof parsed.error === "string") throw new LlmError(parsed.error);
    const piece = parsed.message?.content ?? "";
    if (piece) {
      full += piece;
      onToken?.(piece);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      handleLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }
  handleLine(pending + decoder.decode());
  return full;
}
