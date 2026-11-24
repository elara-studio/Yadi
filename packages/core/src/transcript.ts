/**
 * The session transcript: finished segments plus the current unfinished one.
 * Pure data, no I/O. The Controller feeds it `stt:partial` / `stt:final` events and the chat
 * window displays a snapshot.
 */

export interface Segment {
  id: number;
  text: string;
}

export interface TranscriptSnapshot {
  segments: Segment[];
  /** The in-progress segment (replaced by every `stt:partial`); empty when nothing is pending. */
  partial: string;
}

export class Transcript {
  private segments: Segment[] = [];
  private partial = "";

  /** The unfinished segment changed. */
  applyPartial(text: string): void {
    this.partial = text;
  }

  /** A segment finished: it replaces the partial. A repeated id replaces that segment. */
  applyFinal(id: number, text: string): void {
    this.partial = "";
    const i = this.segments.findIndex((s) => s.id === id);
    if (i >= 0) this.segments[i] = { id, text };
    else this.segments.push({ id, text });
  }

  clear(): void {
    this.segments = [];
    this.partial = "";
  }

  /** True when there is anything to process (finished text or a pending partial). */
  hasContent(): boolean {
    return this.segments.some((s) => s.text.trim() !== "") || this.partial.trim() !== "";
  }

  /** All text, segments then the partial, joined by single spaces. */
  text(): string {
    return [...this.segments.map((s) => s.text), this.partial]
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .join(" ");
  }

  snapshot(): TranscriptSnapshot {
    return { segments: this.segments.map((s) => ({ ...s })), partial: this.partial };
  }
}
