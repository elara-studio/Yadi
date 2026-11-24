import { describe, expect, it, vi } from "vitest";
import { OLLAMA_BASE, OllamaClient } from "./ollamaClient";
import { LlmError, type ChatMessage } from "./types";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const SCHEMA = { type: "object", properties: { a: { type: "string" } } };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const mockFetch = (impl?: FetchLike) => vi.fn<FetchLike>(impl);

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof OllamaClient>[0]> = {},
) {
  return new OllamaClient({ model: "qwen3:4b", fetch: fetchImpl, ...extra });
}
const bodyOf = (f: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse((f.mock.calls[call]?.[1] as RequestInit).body as string) as Record<string, unknown>;

describe("OllamaClient", () => {
  it("posts to /api/chat with the structured-stage settings from the plan", async () => {
    const f = mockFetch(async () => reply(200, { message: { content: '{"a":"b"}' } }));
    const text = await client(f as unknown as typeof fetch).chat({
      messages: MESSAGES,
      schema: SCHEMA,
    });
    expect(text).toBe('{"a":"b"}');
    expect(f.mock.calls[0]?.[0]).toBe(`${OLLAMA_BASE}/api/chat`);
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = bodyOf(f);
    expect(body).toMatchObject({
      model: "qwen3:4b",
      messages: MESSAGES,
      stream: false,
      format: SCHEMA,
      keep_alive: "10m",
      think: false,
      options: { temperature: 0.1, num_ctx: 4096 },
    });
  });

  it("only ever talks to the configured local address", async () => {
    const f = mockFetch(async () => reply(200, { message: { content: "x" } }));
    await client(f as unknown as typeof fetch, { baseUrl: "http://127.0.0.1:11434/" }).chat({
      messages: MESSAGES,
    });
    expect(f.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("omits `format` for free text", async () => {
    const f = mockFetch(async () => reply(200, { message: { content: "x" } }));
    await client(f as unknown as typeof fetch).chat({ messages: MESSAGES });
    expect(bodyOf(f)).not.toHaveProperty("format");
  });

  it("honours custom temperature, context size and keep_alive", async () => {
    const f = mockFetch(async () => reply(200, { message: { content: "x" } }));
    await client(f as unknown as typeof fetch, {
      temperature: 0,
      numCtx: 8192,
      keepAlive: "1h",
    }).chat({ messages: MESSAGES });
    expect(bodyOf(f)).toMatchObject({
      keep_alive: "1h",
      options: { temperature: 0, num_ctx: 8192 },
    });
  });

  it("retries once with format 'json' when the schema is rejected (HTTP 400)", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(400, { error: "invalid JSON schema in format" }))
      .mockResolvedValueOnce(reply(200, { message: { content: '{"ok":true}' } }));
    const text = await client(f as unknown as typeof fetch).chat({
      messages: MESSAGES,
      schema: SCHEMA,
    });
    expect(text).toBe('{"ok":true}');
    expect(f).toHaveBeenCalledTimes(2);
    expect(bodyOf(f, 0).format).toEqual(SCHEMA);
    expect(bodyOf(f, 1).format).toBe("json");
  });

  it("does not retry other errors, and reports Ollama's own message", async () => {
    const f = mockFetch(async () =>
      reply(404, { error: 'model "nope" not found, try pulling it first' }),
    );
    const err = await client(f as unknown as typeof fetch)
      .chat({ messages: MESSAGES, schema: SCHEMA })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(404);
    expect((err as LlmError).message).toContain("not found");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 400 for a plain-json request is not retried again", async () => {
    const f = mockFetch(async () => reply(400, { error: "bad request" }));
    await expect(
      client(f as unknown as typeof fetch).chat({ messages: MESSAGES, schema: "json" }),
    ).rejects.toThrow("bad request");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a network failure becomes an LlmError saying Ollama cannot be reached", async () => {
    const f = mockFetch(async () => Promise.reject(new TypeError("fetch failed")));
    const err = await client(f as unknown as typeof fetch)
      .chat({ messages: MESSAGES })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toContain("Cannot reach Ollama");
  });

  it("an abort passes through unchanged so callers can tell cancel from failure", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = mockFetch(async () => Promise.reject(abort));
    await expect(client(f as unknown as typeof fetch).chat({ messages: MESSAGES })).rejects.toBe(
      abort,
    );
  });

  it("passes the AbortSignal to fetch", async () => {
    const f = mockFetch(async () => reply(200, { message: { content: "x" } }));
    const ctl = new AbortController();
    await client(f as unknown as typeof fetch).chat({ messages: MESSAGES, signal: ctl.signal });
    expect((f.mock.calls[0]?.[1] as RequestInit).signal).toBe(ctl.signal);
  });

  it("an error object in a 200 body, or a body without a message, is an LlmError", async () => {
    const a = mockFetch(async () => reply(200, { error: "model crashed" }));
    await expect(client(a as unknown as typeof fetch).chat({ messages: MESSAGES })).rejects.toThrow(
      "model crashed",
    );
    const b = mockFetch(async () => reply(200, {}));
    await expect(client(b as unknown as typeof fetch).chat({ messages: MESSAGES })).rejects.toThrow(
      "no message",
    );
  });

  it("a non-JSON error body falls back to its text or the status", async () => {
    const a = mockFetch(async () => reply(500, "something broke"));
    await expect(client(a as unknown as typeof fetch).chat({ messages: MESSAGES })).rejects.toThrow(
      "something broke",
    );
    const b = mockFetch(async () => reply(502, ""));
    await expect(client(b as unknown as typeof fetch).chat({ messages: MESSAGES })).rejects.toThrow(
      "HTTP 502",
    );
  });

  it("streams tokens when onToken is given, even when lines are split across chunks", async () => {
    const lines =
      '{"message":{"content":"Hel"},"done":false}\n{"message":{"content":"lo"},"done":false}\n{"message":{"content":""},"done":true}\n';
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // cut in the middle of a line and of a JSON string
        c.enqueue(enc.encode(lines.slice(0, 20)));
        c.enqueue(enc.encode(lines.slice(20, 70)));
        c.enqueue(enc.encode(lines.slice(70)));
        c.close();
      },
    });
    const f = mockFetch(async () => new Response(stream, { status: 200 }));
    const tokens: string[] = [];
    const text = await client(f as unknown as typeof fetch).chat({
      messages: MESSAGES,
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(bodyOf(f).stream).toBe(true);
  });

  it("a stream that carries an error line fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"error":"out of memory"}\n'));
        c.close();
      },
    });
    const f = mockFetch(async () => new Response(stream, { status: 200 }));
    await expect(
      client(f as unknown as typeof fetch).chat({ messages: MESSAGES, onToken: () => {} }),
    ).rejects.toThrow("out of memory");
  });
});
