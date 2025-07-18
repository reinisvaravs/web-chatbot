import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { initData } from "./knowledge/initData.js";
import { handleWebMessage } from "./routes/sendMessage.js";

dotenv.config();

const safeMode = process.env.DEV ? "dev" : "prod";
console.log(`[safeMode: ${safeMode}]`);

const app = express();
const PORT = process.env.PORT || 8383;

app.use(
  cors({
    origin: [
      `${process.env.PROD_FRONTEND_URL}`,
      `${process.env.DEV_FRONTEND_URL}`,
      `${process.env.REINIS_FRONTEND_URL}`,
    ],
  })
);
app.use(express.json());

app.listen(PORT, async () => {
  console.log(`[port: ${PORT}]`);
  await initData();
});

app.post("/api/message", async (req, res) => {
  const { userId, username, content, model, language } = req.body;
  // Log incoming request for debugging
  console.log("[POST /api/message] Incoming body:", req.body);
  // Check for missing env vars
  const requiredEnvs = ["OPENAI_KEY", "DATABASE_URL", "PROD_FRONTEND_URL"];
  const missingEnvs = requiredEnvs.filter((key) => !process.env[key]);
  if (missingEnvs.length > 0) {
    console.error(
      "[POST /api/message] Missing required env vars:",
      missingEnvs
    );
  }
  if (!userId || !username || !content) {
    console.warn("[POST /api/message] Missing fields:", {
      userId,
      username,
      content,
    });
    return res
      .status(400)
      .json({ error: "Missing userId, username, or content" });
  }
  try {
    const response = await handleWebMessage({
      userId,
      username,
      content,
      model,
      language,
    });
    res.json({ response });
  } catch (err) {
    // Improved error logging
    console.error(
      "[POST /api/message] Error:",
      err && err.stack ? err.stack : err
    );
    if (err && err.response && err.response.data) {
      console.error(
        "[POST /api/message] Error response data:",
        err.response.data
      );
    }
    res
      .status(500)
      .json({
        error: "Internal server error",
        details: err && err.message ? err.message : String(err),
      });
  }
});

app.get("/api", (req, res) => {
  res.send("Chatbot API online.");
});
