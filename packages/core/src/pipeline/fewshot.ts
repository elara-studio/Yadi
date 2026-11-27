import type { Analysis, Attachment } from "./types";

/**
 * Worked examples for Stage 2 (Analyze). They were written for this pipeline and are NOT taken
 * from `eval/cases.jsonl` (a script and a test check that no example equals an eval transcript).
 * Every `evidence` is an exact quote of its `cleanText`, which a test also checks.
 */
export interface FewShot {
  cleanText: string;
  attachments?: Attachment[];
  analysis: Analysis;
}

export const FEWSHOT_EXAMPLES: FewShot[] = [
  {
    cleanText:
      "My Kubernetes pod keeps restarting every few minutes. The logs say OOMKilled. It's a Node.js service and I set the memory limit to 256 Mi. Explain why this happens and how to fix it.",
    analysis: {
      task_type: "debugging",
      task: "Explain why the Kubernetes pod keeps restarting and how to fix it.",
      role: { value: "Kubernetes engineer", evidence: "My Kubernetes pod keeps restarting" },
      context: [
        {
          text: "The pod restarts every few minutes",
          evidence: "keeps restarting every few minutes",
        },
        { text: "The logs say OOMKilled", evidence: "The logs say OOMKilled" },
        { text: "It is a Node.js service", evidence: "It's a Node.js service" },
        { text: "The memory limit is set to 256 Mi", evidence: "memory limit to 256 Mi" },
      ],
      constraints: [],
      output_format: null,
      missing_info: ["How much memory does the service use under normal load?"],
    },
  },
  {
    cleanText:
      "Write a short announcement for our new feature, dark mode. Keep it under 80 words, friendly tone, and end with a link to the changelog.",
    analysis: {
      task_type: "writing",
      task: "Write a short announcement for the new dark mode feature.",
      role: null,
      context: [
        {
          text: "The new feature is dark mode",
          evidence: "our new feature, dark mode",
          repeats_task: true,
        },
      ],
      constraints: [
        { text: "Under 80 words", evidence: "under 80 words" },
        { text: "Friendly tone", evidence: "friendly tone" },
        { text: "End with a link to the changelog", evidence: "end with a link to the changelog" },
      ],
      output_format: {
        text: "A short announcement",
        evidence: "short announcement",
        repeats_task: true,
      },
      missing_info: ["What is the link to the changelog?"],
    },
  },
  {
    cleanText: "Can you help me with my presentation? It's tomorrow and I'm kind of stressed.",
    analysis: {
      task_type: "other",
      task: "Help with the presentation.",
      role: null,
      context: [{ text: "The presentation is tomorrow", evidence: "It's tomorrow" }],
      constraints: [],
      output_format: null,
      missing_info: [
        "What is the presentation about?",
        "What kind of help do you need?",
        "Who is the audience?",
      ],
    },
  },
  {
    cleanText:
      "Summarise the attached meeting notes for my manager in five bullet points, plain language.",
    attachments: [{ name: "meeting-notes.docx", type: "docx" }],
    analysis: {
      task_type: "writing",
      task: "Summarise the attached meeting notes for the manager.",
      role: null,
      context: [
        { text: "The summary is for the manager", evidence: "for my manager", repeats_task: true },
      ],
      constraints: [
        { text: "Exactly five bullet points", evidence: "in five bullet points" },
        { text: "Plain language", evidence: "plain language" },
      ],
      output_format: null,
      missing_info: [],
    },
  },
  {
    cleanText:
      "I'm learning Python. What's the difference between a list and a tuple? Please don't use jargon.",
    analysis: {
      task_type: "explanation",
      task: "Explain the difference between a list and a tuple in Python.",
      role: { value: "Patient Python tutor", evidence: "I'm learning Python" },
      context: [
        { text: "The person is learning Python", evidence: "I'm learning Python" },
        { text: "Assumed: beginner level", evidence: "I'm learning Python" },
      ],
      constraints: [{ text: "Avoid jargon", evidence: "don't use jargon" }],
      output_format: null,
      missing_info: [],
    },
  },
  {
    cleanText: "How do I make a Flutter button show a loading spinner while an API call runs?",
    analysis: {
      task_type: "coding",
      task: "Explain how to show a loading spinner on a Flutter button during an API call.",
      role: { value: "Flutter developer", evidence: "Flutter button" },
      context: [
        { text: "It is a Flutter app", evidence: "Flutter button", repeats_task: true },
        {
          text: "The button shows a loading spinner",
          evidence: "show a loading spinner",
          repeats_task: true,
        },
      ],
      constraints: [],
      output_format: null,
      missing_info: [],
    },
  },
  {
    cleanText:
      "My partner and I want to repaint the living room. We thought about blue or green and picked green, blue is too dark. We can spend about 150 euros on paint and tools, and we only have Saturday. The room gets little sunlight and we have a cat, so no strong smells. Give me a shopping list and a step-by-step plan.",
    analysis: {
      task_type: "planning",
      task: "Plan repainting the living room.",
      role: null,
      context: [
        { text: "Two people painting the living room", evidence: "My partner and I" },
        { text: "The room gets little sunlight", evidence: "The room gets little sunlight" },
        { text: "A cat lives there", evidence: "we have a cat" },
      ],
      constraints: [
        { text: "Blue paint", evidence: "We thought about blue", turned_down: true },
        { text: "Green paint", evidence: "picked green" },
        {
          text: "About 150 euros for paint and tools",
          evidence: "about 150 euros on paint and tools",
        },
        { text: "Done on Saturday only", evidence: "we only have Saturday" },
        { text: "No strong-smelling products", evidence: "no strong smells" },
      ],
      output_format: {
        text: "A shopping list and a step-by-step plan",
        evidence: "a shopping list and a step-by-step plan",
      },
      missing_info: [],
    },
  },
  {
    cleanText:
      "Write a message to my football club group. Tuesday training moves from 6 to 7 pm because the field is booked. Keep it short and cheerful, they don't need the details. In French. It's a WhatsApp message.",
    analysis: {
      task_type: "writing",
      task: "Write a message to the football club group about the training time.",
      role: null,
      context: [
        {
          text: "Tuesday training moves from 6 to 7 pm",
          evidence: "Tuesday training moves from 6 to 7 pm",
        },
        { text: "Reason: the field is booked", evidence: "because the field is booked" },
      ],
      constraints: [
        { text: "Short and cheerful", evidence: "short and cheerful" },
        { text: "In French", evidence: "In French" },
      ],
      output_format: { text: "A WhatsApp message", evidence: "a WhatsApp message" },
      missing_info: [],
    },
  },
];
