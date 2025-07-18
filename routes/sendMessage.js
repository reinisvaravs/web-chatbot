import {
  getFormattedHistory,
  addToMessageHistory,
} from "../stats/userMemory.js";
import { getRelevantChunksForMessage } from "../knowledge/gnosisManager.js";
import { aiResponse } from "../ai/aiResponse.js";
import { buildPrompt } from "../ai/buildPrompt.js";
import { OpenAI } from "openai";
import { logAuditEntry, getUserData } from "../db.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// Pricing per 1M tokens (as of June 2025)
const PRICING = {
  "gpt-4o": { input: 0.0025, output: 0.01 }, // $2.50/m input, $10/m output
  "gpt-4o-mini": { input: 0.0011, output: 0.0044 }, // $1.10/m input, $4.40/m output
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 }, // $0.50/m input, $1.50/m output
  // Add more models as needed
};

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

function getLanguageSpecificResponse(language = "en") {
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

// Helper: reduce calendar availability to only day, date, and intervals (no UTC)
export function minimalCalendarAvailability(raw) {
  return Object.values(raw).map((dayObj) => ({
    day: dayObj.day.charAt(0).toUpperCase() + dayObj.day.slice(1),
    date: dayObj.date,
    intervals: (dayObj.intervals || []).map(
      (interval) => interval.split(" ")[0]
    ),
  }));
}

// Handles a web chat message and returns the bot's response
export async function handleWebMessage({
  userId,
  username,
  content,
  model,
  language = "en",
}) {
  const selectedModel = model || DEFAULT_MODEL;
  try {
    // Guardrail check BEFORE any LLM call
    if (isBlockedQuery(content)) {
      const { safeResponse } = getLanguageSpecificResponse(language);
      await logAuditEntry(userId, username, content, safeResponse);
      return safeResponse;
    }
    const history = await getFormattedHistory(userId);
    const userData = await getUserData(userId);
    const relevantChunks = await getRelevantChunksForMessage(content, 5, 0.75);
    let systemPrompt = buildPrompt(relevantChunks, content, language);
    // Build the messages array for the next OpenAI call
    const minimalCalendar =
      userData && userData.calendar_availability
        ? minimalCalendarAvailability(userData.calendar_availability)
        : null;

    console.log("BEFORE userData: ", userData);

    const messages = [
      {
        role: "system",
        content: `Current date and time: ${new Date().toISOString()}`,
      },
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Official Calendar Availability: ${
          minimalCalendar ? JSON.stringify(minimalCalendar) : "none"
        }`,
      },
      {
        role: "system",
        content: `User data: ${userData ? JSON.stringify(userData) : "none"}`,
      },
      ...history.map((m) => {
        // Ensure content is always a string
        let content = m.content;
        // If content is an object, try to extract the message
        if (typeof content === "object" && content !== null) {
          if (content.message) {
            content = content.message;
          } else {
            content = JSON.stringify(content);
          }
        }
        // If content is not a string, convert it
        if (typeof content !== "string") {
          content = String(content);
        }
        // Handle JSON parsing for assistant messages
        if (m.role === "assistant" && content.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(content);
            // Only send the 'message' field if it exists
            content = parsed.message || "";
          } catch (e) {
            console.warn(
              "[handleWebMessage] Failed to parse assistant message JSON:",
              e,
              content
            );
            // If parsing fails, keep the raw content
          }
        }
        return {
          role: m.role,
          name: sanitizeName(m.name),
          content: content,
        };
      }),
    ];
    // Now the new user message
    messages.push({ role: "user", name: sanitizeName(username), content });
    // GET AI RESPONSE
    const { response, message } = await aiResponse(
      openai,
      messages,
      selectedModel,
      userId
    );
    await addToMessageHistory(userId, "user", username, content);
    await addToMessageHistory(
      userId,
      "assistant",
      "Assistant",
      message || "(No response)"
    );
    await logAuditEntry(userId, username, content, response);
    return message || null;
  } catch (err) {
    console.error(
      "[handleWebMessage] Error:",
      err && err.stack ? err.stack : err
    );
    throw err;
  }
}
