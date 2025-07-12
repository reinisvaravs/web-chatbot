import { setTimeout as wait } from "node:timers/promises";
import { findSimilarChunks } from "../db.js";
import { OpenAI } from "openai";
import { google } from "googleapis";
import fs from "fs";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

// Helper function to get the key file path from env (supports raw JSON or file path)
function getKeyFilePath() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv)
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_KEY in environment variables"
    );
  // If it looks like a JSON object, write to a temp file
  if (keyEnv.trim().startsWith("{")) {
    const tempPath = "./.google-service-account.temp.json";
    fs.writeFileSync(tempPath, keyEnv);
    return tempPath;
  }
  // Otherwise, treat as file path
  return keyEnv;
}

// Helper function to upsert a row to Google Sheets (update if exists, insert if not)
async function upsertToGoogleSheet(userData, userId) {
  const KEYFILEPATH = getKeyFilePath();
  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SHEET_NAME = "Chatbot";

  if (!SPREADSHEET_ID)
    throw new Error("Missing GOOGLE_SHEET_ID in environment variables");

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEYFILEPATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // First, get all existing data to check for duplicates
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
    });

    const rows = existingData.data.values || [];
    let rowIndex = -1;

    // Find existing row by userId (column G)
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][6] === userId) {
          // userId is in column G (index 6)
          rowIndex = i + 1; // Google Sheets is 1-indexed
          break;
        }
      }
    }

    const newRow = [
      userData.name || "",
      userData.email || "",
      userData.reason || "",
      new Date().toISOString(),
      userData.city || "",
      userData.colleague || "",
      userId || "",
    ];

    if (rowIndex > 0) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowIndex}:G${rowIndex}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newRow] },
      });
      console.log(
        `Updated existing row at index ${rowIndex} for userId: ${userId}`
      );
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:G`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newRow] },
      });
      console.log(`Created new row for userId: ${userId}`);
    }
  } finally {
    // Clean up temp file if it was created
    if (
      KEYFILEPATH === "./.google-service-account.temp.json" &&
      fs.existsSync(KEYFILEPATH)
    ) {
      try {
        fs.unlinkSync(KEYFILEPATH);
        console.log("Cleaned up temporary Google service account file");
      } catch (e) {
        console.warn("Failed to clean up temp file:", e.message);
      }
    }
  }
}

export async function aiResponse(
  openai,
  messages,
  selectedModel,
  userId,
  language = "en"
) {
  let retries = 2;
  let delay = 5000;

  // Get the latest user message
  const userMessage = messages[messages.length - 1]?.content || "";

  // Step 1: Pre-check if RAG is needed
  const preCheckPrompt = `Does this user message require information from the knowledge base to answer helpfully, or can it be answered without it? Reply only "yes" or "no". Message: "${userMessage}"`;
  let needsRAG = false;
  try {
    const preCheckResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: preCheckPrompt }],
    });
    needsRAG =
      preCheckResponse.choices[0].message.content.trim().toLowerCase() ===
      "yes";
    console.log("needsRAG =", needsRAG);
  } catch (e) {
    console.warn("RAG pre-check failed, defaulting to including RAG.", e);
    needsRAG = true;
  }

  // Step 2: Get relevant chunks if needed
  const relevantChunks = needsRAG
    ? await getRelevantChunksForMessage(userMessage)
    : [];

  // Build conversation history (excluding the latest user message)
  const conversationHistory = messages
    .slice(0, -1)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  // Step 3: Build the prompt
  const { buildPrompt } = await import("./buildPrompt.js");
  const prompt = buildPrompt(
    relevantChunks,
    userMessage,
    language,
    conversationHistory
  );

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: selectedModel,
        messages: [{ role: "system", content: prompt }, ...messages],
      });
      const content = response.choices?.[0]?.message?.content || "";
      // Extract any JSON object (broad match)
      const jsonAnyRegex = /\{[\s\S]*?\}/;
      const match = content.match(jsonAnyRegex);
      if (match) {
        let userData = null;
        let jsonStr = match[0];
        try {
          userData = JSON.parse(jsonStr);
        } catch (e) {
          // Try converting single quotes to double quotes and parse again
          try {
            jsonStr = jsonStr.replace(/'/g, '"');
            userData = JSON.parse(jsonStr);
          } catch (e2) {
            console.log(
              "User data JSON detected but failed to parse:",
              match[0]
            );
          }
        }
        if (userData) {
          console.log("User data detected in response:", userData);
          await upsertToGoogleSheet(userData, userId);
        }
      }
      return response;
    } catch (err) {
      if (err.status === 429 && attempt <= retries) {
        console.warn(
          `⚠️ Rate limit hit (attempt ${attempt}). Retrying in ${
            delay / 1000
          }s...`
        );
        await wait(delay);
        delay *= 2;
      } else {
        console.error("OpenAI Error:\n", err);
        return null;
      }
    }
  }
}

// finds similar chunks of info to message
export async function getRelevantChunksForMessage(
  message,
  topK = 5,
  minScore = 0.75
) {
  const res = await openai.embeddings.create({
    input: message,
    model: "text-embedding-3-large",
  });

  const messageVector = res.data[0].embedding;
  const topChunks = await findSimilarChunks(messageVector, topK * 2);
  const maxScore = 1 - minScore;
  const filtered = topChunks.filter((c) => c.score <= maxScore);
  // If not enough, fallback to topK best
  const finalChunks =
    filtered.length >= topK
      ? filtered.slice(0, topK)
      : topChunks.slice(0, topK);
  global.lastUsedChunks = finalChunks;
  return finalChunks.map((c) => c.chunk);
}
