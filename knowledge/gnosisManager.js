import { OpenAI } from "openai";
import {
  fetchAndParseR2Docs, // downloads and parses file content into a big string
} from "./fileLoader.js";
import { hasFileChanged } from "./hashCheck.js";
import {
  saveVectorChunk,
  loadAllVectors,
  deleteVectorChunk,
  getAllStoredFileNames,
  deleteFileHash,
  findSimilarChunks,
} from "../db.js";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

let embeddedChunks = []; // stores: [{ string chunk, vector }]
// Utility: Split text into paragraphs, then sentences
function splitTextToSentences(text) {
  // Simple sentence splitter (can be improved with NLP libs)
  return text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
}

function splitTextToParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Robust chunking: no split in middle of sentence/paragraph, with overlap
function splitIntoChunks(text, maxTokens = 150, overlapRatio = 0.2) {
  const paragraphs = splitTextToParagraphs(text);
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  let tokensPerChunk = maxTokens;
  let overlapSentences = [];

  for (const para of paragraphs) {
    const sentences = splitTextToSentences(para);
    for (const sentence of sentences) {
      const sentenceTokens = Math.ceil(sentence.length / 4); // rough estimate
      if (currentTokens + sentenceTokens > tokensPerChunk) {
        // Add overlap (20% of previous chunk's sentences)
        const overlapCount = Math.ceil(currentChunk.length * overlapRatio);
        overlapSentences = currentChunk.slice(-overlapCount);
        chunks.push(currentChunk.join(" ").trim());
        // Start new chunk with overlap
        currentChunk = [...overlapSentences, sentence];
        currentTokens =
          overlapSentences.reduce(
            (sum, s) => sum + Math.ceil(s.length / 4),
            0
          ) + sentenceTokens;
      } else {
        currentChunk.push(sentence);
        currentTokens += sentenceTokens;
      }
    }
  }
  if (currentChunk.length) {
    chunks.push(currentChunk.join(" ").trim());
  }
  return chunks;
}

// check for changes in vectors
export async function loadAndEmbedKnowledge() {
  embeddedChunks = await loadAllVectors(); // prev vectors from db

  // Local fetch for new/updated files
  const files = await fetchAndParseR2Docs(); // parsed all contents of a file

  try {
    await checkDeleted(files); // deletes files from db that are not in the docs folder
  } catch (error) {
    console.error("❌ Error in checkDeleted():", error);
  }

  let totalChunks = 0; // total re-embedded chunks
  const dbIsEmpty = embeddedChunks.length === 0;

  for (let fileText of files) {
    fileText = fileText.trim();
    const nameMatch = fileText.match(/^\[(.*?)\]/);
    const name = nameMatch?.[1]?.trim() || "unknown_file";
    const content = fileText.slice(nameMatch[0].length).trim();

    // If DB is empty, force embedding; otherwise, check for changes
    if (!dbIsEmpty && !(await hasFileChanged(name, content))) {
      continue; // stops the current iteration, moves on to next
    }

    const chunks = splitIntoChunks(content);
    await deleteVectorChunk(name); // deletes all chunks of a changed file

    for (const chunk of chunks) {
      const labeledChunk = `[${name}]\n${chunk}`;

      const res = await openai.embeddings.create({
        input: labeledChunk,
        model: "text-embedding-3-large",
      });

      const vector = res.data[0].embedding;

      embeddedChunks.push({
        chunk: labeledChunk,
        vector,
      });

      await saveVectorChunk(name, labeledChunk, vector); // saves the chunks to db
    }
    totalChunks += chunks.length;
  }

  // LOGS
  if (totalChunks === 0) {
    if (dbIsEmpty) {
      console.log("⚠️ Database is empty and no docs were found to embed.");
    } else {
      console.log("✅ All files are up to date — no re-embedding needed.");
    }
  } else {
    console.log(`📥 Total re-embedded chunks: ${totalChunks}`);
  }

  return true;
}

// deletes files from db that are not in the docs db
async function checkDeleted(files) {
  // returns array of strings of file names in github repo
  const currentGitHubFiles = files
    .map((f) => {
      const nameMatch = f.match(/\[(.*?)\]/); // a capture group, returns e.g. ["[guide.md]", "guide.md"]
      return nameMatch?.[1]?.trim(); // return only the string file name e.g. "guide.md"
    })
    .filter(Boolean); // removes falsy values (e.g. undefined)

  // returns array of strings of file names in neondb
  const dbFiles = await getAllStoredFileNames();

  const deletedFiles = dbFiles.filter(
    (file) => !currentGitHubFiles.includes(file)
  ); // selects files to delete

  // deletes selected files
  for (const deleted of deletedFiles) {
    await deleteVectorChunk(deleted);
    await deleteFileHash(deleted);
    console.log(`🗑️ Deleted all chunks for removed file: ${deleted}`);
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
