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
  if (!userId || !username || !content) {
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
    console.error("Error in /api/message:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (req, res) => {
  res.send("Chatbot API online.");
});
