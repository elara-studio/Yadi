import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const fetchMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
const { tauriPorts } = await import("./tauriPorts");

const reply = (content: unknown) =>
  new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });

const TRANSCRIPT = "write a note about the Zorblax project";
const analysis = {
  task_type: "writing",
  task: "Write a note about the Zorblax project.",
  role: null,
  context: [],
  constraints: [],
  output_format: null,
  missing_info: [],
};

beforeEach(() => {
  invoke.mockReset();
  fetchMock.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "select_model_tier") return { result: "tier", llm_tag: "chosen:tag" };
    if (cmd === "get_vocabulary") return ["Zorblax"];
    return undefined;
  });
  fetchMock
    .mockResolvedValueOnce(reply({ clean_text: "Write a note about the Zorblax project." }))
    .mockResolvedValueOnce(reply(analysis));
});

describe("tauriPorts.runPipeline", () => {
  it("uses the model Settings chose (via select_model_tier) and the user's vocabulary", async () => {
    const result = await tauriPorts.runPipeline({ transcript: TRANSCRIPT });
    expect(result.prompt).toContain("Zorblax");
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.model === "chosen:tag")).toBe(true);
    // the vocabulary reaches the Stage 1 request
    expect(JSON.stringify(bodies[0].messages)).toContain("Zorblax");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("still works when the vocabulary cannot be read", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "select_model_tier") return { result: "tier", llm_tag: "chosen:tag" };
      throw new Error("no store");
    });
    const result = await tauriPorts.runPipeline({ transcript: TRANSCRIPT });
    expect(result.degraded).toBe(false);
  });

  it("an unsupported computer is an error, not a request", async () => {
    invoke.mockImplementation(async () => ({ result: "unsupported", reason: "not enough memory" }));
    await expect(tauriPorts.runPipeline({ transcript: TRANSCRIPT })).rejects.toThrow(
      /cannot run the language model/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tauriPorts.warmModel", () => {
  it("loads the chosen model with an empty request when Ollama is running", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "ollama_status"
        ? { state: "running", version: "0.1" }
        : { result: "tier", llm_tag: "chosen:tag" },
    );
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}"));
    await tauriPorts.warmModel();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/generate");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "chosen:tag",
      keep_alive: "10m",
    });
  });

  it("does nothing when Ollama is not running", async () => {
    invoke.mockImplementation(async () => ({ state: "installed", path: "/x" }));
    fetchMock.mockReset();
    await tauriPorts.warmModel();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
