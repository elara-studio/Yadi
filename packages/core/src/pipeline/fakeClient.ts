import { abortError } from "./abort";
import { LlmError, type ChatRequest, type LlmClient } from "./types";

/** One scripted reply: a fixed text, a function of the request, or an error to throw. */
export type FakeReply = string | Error | ((request: ChatRequest) => string | Promise<string>);

/**
 * A scripted language model for tests: returns its replies in order and records every request.
 * Honours `AbortSignal`, so cancellation can be tested.
 */
export class FakeLlmClient implements LlmClient {
  readonly requests: ChatRequest[] = [];
  private next = 0;

  constructor(private readonly replies: FakeReply[]) {}

  async chat(request: ChatRequest): Promise<string> {
    this.requests.push(request);
    if (request.signal?.aborted) throw abortError();
    const reply = this.replies[this.next++];
    if (reply === undefined) throw new LlmError("FakeLlmClient: no more scripted replies");
    if (reply instanceof Error) throw reply;
    const text =
      typeof reply === "function" ? await raceAbort(reply(request), request.signal) : reply;
    if (request.signal?.aborted) throw abortError();
    return text;
  }
}

function raceAbort<T>(work: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A reply that never finishes until the request is aborted (for cancellation tests). */
export const hang: FakeReply = () => new Promise<string>(() => {});
