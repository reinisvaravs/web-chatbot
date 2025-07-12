import {
  getFormattedHistory,
  addToMessageHistory,
} from "../stats/userMemory.js";
import { getRelevantChunksForMessage } from "../ai/aiResponse.js";
import { aiResponse } from "../ai/aiResponse.js";
import { buildPrompt } from "../ai/buildPrompt.js";
import { OpenAI } from "openai";
import { incrementStat, addStatValue, logAuditEntry } from "../db.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// Pricing per 1M tokens (as of June 2025)
const PRICING = {
  "gpt-4o": { input: 0.0025, output: 0.01 }, // $2.50/m input, $10/m output
  "gpt-4o-mini": { input: 0.0011, output: 0.0044 }, // $1.10/m input, $4.40/m output
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 }, // $0.50/m input, $1.50/m output
  // Add more models as needed
};

function getModelPricing(model) {
  if (model in PRICING) return PRICING[model];
  // fallback to gpt-4o if unknown
  return PRICING["gpt-4o"];
}

// Guardrail: block unsafe/inappropriate/out-of-scope questions
const BLOCKED_PATTERNS = [
  /medical|diagnos(e|is|es)|prescrib(e|ing|ed)|symptom|treatment|therapy|disease|illness|cure|medicine|drug|health advice/i,
  /legal|lawyer|attorney|sue|lawsuit|court|contract|will|testament|notar(y|ize)|legal advice/i,
  /social security number|ssn|credit card|bank account|password|private key|passport|personal data|PII|address|phone number|email address/i,
  /suicide|self-harm|violence|harm|kill|murder|weapon|bomb|terror/i,
  /bypass|ignore|disable|jailbreak|prompt injection|act as|forget you are|break your rules|override your instructions/i,
  /sexual|porn|nude|explicit|abuse|groom|molest|rape|incest|child|minor|underage/i,
  /racist|hate|slur|offensive|insult|bully|harass|discriminate/i,
];

function isBlockedQuery(query) {
  return BLOCKED_PATTERNS.some((re) => re.test(query));
}

function isUncertainResponse(botReply) {
  return (
    !botReply ||
    botReply === "(No response)" ||
    /I don\'t know|cannot answer|no information|not sure|unsure|uncertain|unknown|sorry, I can\'t|Sorry, I can't|nezinu|nevaru atbildēt|nav informācijas|neesmu pārliecināts|neesmu drošs|nenoteikts|nezināms|atvainojiet, es nevaru|Atvainojiet, es nevaru/i.test(
      botReply
    )
  );
}

function getLanguageSpecificResponse(message, language = "en") {
  switch (language) {
    case "lv":
      return {
        safeResponse: "Atvainojiet, es nevaru palīdzēt ar to.",
      };
    case "en":
    default:
      return {
        safeResponse: "Sorry, I can't help with that.",
      };
  }
}

// Helper to sanitize names for OpenAI API (alphanumeric and underscores only)
function sanitizeName(name) {
  if (!name) return undefined;
  // Remove invalid characters: anything except letters, numbers, and underscores
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

// Handles a web chat message and returns the bot's response
export async function handleWebMessage({
  userId,
  username,
  content,
  model,
  language = "en",
  escalateToHuman = false,
}) {
  const selectedModel = model || DEFAULT_MODEL;
  await incrementStat("total_messages_in");

  // Guardrail check BEFORE any LLM call
  if (isBlockedQuery(content)) {
    const { safeResponse } = getLanguageSpecificResponse("", language);
    await logAuditEntry(userId, username, content, safeResponse);
    return safeResponse;
  }

  const history = await getFormattedHistory(userId);
  // Retrieve top 5 relevant chunks with semantic filtering
  const relevantChunks = await getRelevantChunksForMessage(content, 5, 0.75);
  const systemPrompt = buildPrompt(relevantChunks, content, language);
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({
      role: m.role,
      name: sanitizeName(m.name),
      content: m.content,
    })),
    { role: "user", name: sanitizeName(username), content },
  ];
  const completion = await aiResponse(openai, messages, selectedModel, userId);
  const botReply =
    completion?.choices?.[0]?.message?.content?.trim() || "(No response)";

  // Human-in-the-loop: queue for review if uncertain, sensitive, or user escalates
  let shouldQueue = false;
  let reason = null;

  if (isUncertainResponse(botReply)) {
    shouldQueue = true;
    reason = "uncertain";
  } else if (escalateToHuman) {
    shouldQueue = true;
    reason = "user escalation";
  }

  if (botReply && botReply !== "(No response)") {
    await incrementStat("total_messages_out");
  }

  if (completion?.usage) {
    const { prompt_tokens, completion_tokens } = completion.usage;
    const modelKey = `total_tokens_${selectedModel}`;
    const tokensThisMessage = prompt_tokens + completion_tokens;

    await addStatValue(modelKey, tokensThisMessage);

    const pricing = getModelPricing(selectedModel);
    const costThisMessage =
      (tokensThisMessage * (pricing.input + pricing.output)) / 1_000_000;
    const costKey = `total_cost_${selectedModel}`;

    await addStatValue(costKey, costThisMessage);
  }

  await addToMessageHistory(userId, "user", username, content);
  await addToMessageHistory(userId, "assistant", "Assistant", botReply);

  await logAuditEntry(userId, username, content, botReply);
  return botReply;
}
