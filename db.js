import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// deletes all chunks and vectors of a changed file
export async function deleteVectorChunk(fileName) {
  await pool.query(`DELETE FROM vectors WHERE file_name = $1`, [fileName]);
}

export async function deleteFileHash(fileName) {
  await pool.query(`DELETE FROM file_hashes WHERE file_name = $1`, [fileName]);
  console.log("[deleting hash from}:", fileName);
}

// saves chunks to db
export async function saveVectorChunk(fileName, chunk, embedding) {
  const vectorString = `[${embedding.join(",")}]`; // Converts JS array to PostgreSQL vector string
  await pool.query(
    `INSERT INTO vectors (file_name, chunk, embedding_vector)
     VALUES ($1, $2, $3::vector)`,
    [fileName, chunk, vectorString]
  );
  console.log("[updating]: ", fileName);
}

// gets chunk vectors form db
export async function loadAllVectors() {
  const result = await pool.query(
    "SELECT file_name, chunk, embedding_vector FROM vectors"
  );
  return result.rows.map((row) => ({
    chunk: `[${row.file_name}]\n${row.chunk}`,
    vector: row.embedding_vector,
  }));
}

// finds similar chunks of info to message in postgreSQL
export async function findSimilarChunks(messageEmbedding, topN) {
  const vectorString = `[${messageEmbedding.join(",")}]`; // PostgreSQL vector format

  const result = await pool.query(
    `
    SELECT file_name, chunk, embedding_vector <#> $1 AS score
    FROM vectors
    ORDER BY embedding_vector <#> $1
    LIMIT $2
    `,
    [vectorString, topN]
  );

  // score is L2 distance: lower is more similar
  return result.rows;
}

// returns hash of passed file
export async function getStoredFileHash(filename) {
  const result = await pool.query(
    `SELECT hash FROM file_hashes WHERE file_name = $1`,
    [filename]
  );
  return result.rows[0]?.hash || null;
}

// ads or updates hash
export async function storeFileHash(filename, hash) {
  await pool.query(
    `
    INSERT INTO file_hashes (file_name, hash)
    VALUES ($1, $2)
    ON CONFLICT (file_name) DO UPDATE SET hash = EXCLUDED.hash
    `,
    [filename, hash]
  );
}

// gets file names from neondb
export async function getAllStoredFileNames() {
  const res = await pool.query("SELECT DISTINCT file_name FROM vectors"); // returns array of jsons
  return res.rows.map((r) => r.file_name); // returns array of strings of file names
}

export async function incrementStat(key) {
  await pool.query(
    `INSERT INTO bot_stats (stat_key, value)
     VALUES ($1, 1)
     ON CONFLICT (stat_key)
     DO UPDATE SET value = bot_stats.value + 1`,
    [key]
  );
}

export async function addStatValue(key, value) {
  await pool.query(
    `INSERT INTO bot_stats (stat_key, value)
     VALUES ($1, $2)
     ON CONFLICT (stat_key)
     DO UPDATE SET value = bot_stats.value + $2`,
    [key, value]
  );
}

// Logs a user query and bot response to the audit log
export async function logAuditEntry(userId, username, userQuery, botResponse) {
  await pool.query(
    `INSERT INTO audit_log (user_id, username, user_query, bot_response) VALUES ($1, $2, $3, $4)`,
    [userId, username, userQuery, botResponse]
  );
}

export default pool;
