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
      context: [{ text: "The new feature is dark mode", evidence: "our new feature, dark mode" }],
      constraints: [
        { text: "Under 80 words", evidence: "under 80 words" },
        { text: "Friendly tone", evidence: "friendly tone" },
        { text: "End with a link to the changelog", evidence: "end with a link to the changelog" },
      ],
      output_format: { text: "A short announcement", evidence: "short announcement" },
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
      "I have a Postgres table with 12 million rows and this query takes 40 seconds. It joins orders and customers on customer id and filters by date. How can I make it faster?",
    analysis: {
      task_type: "data",
      task: "Suggest how to make the slow Postgres query faster.",
      role: { value: "PostgreSQL performance expert", evidence: "I have a Postgres table" },
      context: [
        { text: "The table has 12 million rows", evidence: "table with 12 million rows" },
        { text: "The query takes 40 seconds", evidence: "takes 40 seconds" },
        {
          text: "The query joins orders and customers on customer id and filters by date",
          evidence: "joins orders and customers on customer id and filters by date",
        },
      ],
      constraints: [],
      output_format: null,
      missing_info: ["Which indexes exist on these tables?"],
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
      context: [{ text: "The summary is for the manager", evidence: "for my manager" }],
      constraints: [
        { text: "Exactly five bullet points", evidence: "in five bullet points" },
        { text: "Plain language", evidence: "plain language" },
      ],
      output_format: { text: "Five bullet points", evidence: "five bullet points" },
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
        { text: "It is a Flutter app", evidence: "Flutter button" },
        { text: "The button should show a loading spinner", evidence: "show a loading spinner" },
        { text: "An API call is running", evidence: "while an API call runs" },
      ],
      constraints: [],
      output_format: null,
      missing_info: [],
    },
  },
  {
    cleanText:
      "Create a Bash script that backs up my home folder to an external drive every night.",
    analysis: {
      task_type: "coding",
      task: "Write a Bash script that backs up the home folder to an external drive every night.",
      role: null,
      context: [
        { text: "The script is written in Bash", evidence: "Bash script" },
        { text: "The folder to back up is the home folder", evidence: "my home folder" },
        { text: "The backup goes to an external drive", evidence: "to an external drive" },
        { text: "It runs every night", evidence: "every night" },
      ],
      constraints: [],
      output_format: null,
      missing_info: [],
    },
  },
];
