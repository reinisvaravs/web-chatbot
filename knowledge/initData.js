// Gets the bot data by loading knowledge and refreshing the system prompt.

import { loadAndEmbedKnowledge } from "./gnosisManager.js";

export async function initData() {
  await loadAndEmbedKnowledge();

  // auto-refresh knowledge + prompt
  setInterval(async () => {
    console.log("🔄 Auto-refreshing knowledge");
    await loadAndEmbedKnowledge();
  }, 60 * 60 * 1000); // hourly refresh
}
