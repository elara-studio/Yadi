/**
 * The session transcript: finished segments plus the current unfinished one.
 * Pure data, no I/O. The Controller feeds it `stt:partial` / `stt:final` events and the chat
 * window displays a snapshot.
 *
 * Recording boundaries: Rust numbers segments from 0 in every recording, so `beginRecording`
 * records an offset and later ids are shifted by it. The audio buffer (and so the final pass)
 * covers the segments from `audioBase` on; once the buffer has been freed, `markAudioFreed`
 * moves that boundary so a later final pass can only replace newer text.
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
  /** Added to ids coming from Rust, so a new recording never overwrites earlier segments. */
  private idOffset = 0;
  /** Index of the first segment whose audio is still in the recording buffer. */
  private audioBase = 0;

  /** A new recording starts: its segment ids begin after the existing ones. */
  beginRecording(): void {
    this.idOffset = this.nextId();
    this.partial = "";
  }

  /** The unfinished segment changed. */
  applyPartial(text: string): void {
    this.partial = text;
  }

  /** A segment finished: it replaces the partial. A repeated id replaces that segment. */
  applyFinal(id: number, text: string): void {
    this.partial = "";
    const shifted = id + this.idOffset;
    const i = this.segments.findIndex((s) => s.id === shifted);
    if (i >= 0) this.segments[i] = { id: shifted, text };
    else this.segments.push({ id: shifted, text });
  }

  /**
   * The final pass produced `text` for the audio in the buffer: it replaces all segments from
   * `audioBase` on (and the partial) in one step. Earlier, already-polished text stays.
   */
  replaceRecordedAudio(text: string): void {
    const id = this.nextId();
    this.segments = this.segments.slice(0, this.audioBase);
    this.partial = "";
    if (text.trim() !== "") this.segments.push({ id: Math.max(id, this.audioBase), text });
  }

  /**
   * The recording buffer was emptied: audio for segments before `upTo` (default: all current
   * segments) can no longer be re-transcribed.
   */
  markAudioFreed(upTo: number = this.segments.length): void {
    this.audioBase = Math.min(upTo, this.segments.length);
  }

  /** Number of finished segments (a stable marker for `markAudioFreed`). */
  segmentCount(): number {
    return this.segments.length;
  }

  clear(): void {
    this.segments = [];
    this.partial = "";
    this.idOffset = 0;
    this.audioBase = 0;
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

  private nextId(): number {
    return this.segments.reduce((max, s) => Math.max(max, s.id + 1), 0);
  }
}
