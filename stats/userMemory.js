import pool from "../db.js";

const MAX_HISTORY = 12; // how many messages to keep in memory per user

// Loads conversation history for a given user from DB
// this is sent to gpt each req
export async function getFormattedHistory(userId) {
  try {
    const result = await pool.query(
      "SELECT memory FROM user_memory WHERE user_id = $1",
      [userId]
    );

    const memory = result.rows[0]?.memory || [];
    return memory;
  } catch (err) {
    console.error("❌ Failed to load memory for user:", userId, err);
    return [];
  }
}

// Saves a new message to a user's memory (trims oldest if needed)
export async function addToMessageHistory(userId, role, name, content) {
  try {
    // Get current history
    const result = await pool.query(
      "SELECT memory FROM user_memory WHERE user_id = $1",
      [userId]
    );

    const history = result.rows[0]?.memory || [];

    // Add the new message
    history.push({ role, name, content });

    // Trim if over limit
    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Insert or update
    await pool.query(
      `
      INSERT INTO user_memory (user_id, memory)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET memory = EXCLUDED.memory
      `,
      [userId, JSON.stringify(history)]
    );
  } catch (err) {
    console.error("❌ Failed to save message history for user:", userId, err);
  }
}
