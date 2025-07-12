# Web Chatbot

A web-based AI assistant powered by OpenAI, featuring persistent user memory, robust security guardrails, and knowledge sourced from a GitHub repository.

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
  - [Clone the Repository](#1-clone-the-repository)
  - [Install Dependencies](#2-install-dependencies)
  - [Configure Environment Variables](#3-configure-environment-variables)
  - [Set Up the Database](#4-set-up-the-database)
  - [Start the Server](#5-start-the-server)
- [API Endpoints](#api-endpoints)
- [Security & Guardrails](#security--guardrails)
- [Knowledge Management](#knowledge-management)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)
- [Acknowledgements](#acknowledgements)

---

## Features

- **Conversational AI**: Chat with an OpenAI-powered assistant.
- **Persistent Memory**: Each user has a unique, private chat history.
- **Knowledge Injection**: Teach the bot by adding files to a GitHub repo.
- **Strong Guardrails**: Blocks unsafe, inappropriate, or out-of-scope queries.
- **API-first**: Simple REST API for integration.
- **Auto-refresh**: Knowledge and system prompt auto-refresh every 10 minutes.

---

## Quick Start

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd web-chatbot-rag
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root with the following variables:

```env
OPENAI_KEY=
GITHUB_TOKEN=
REPO_API_URL=https://api.github.com/repos/reinisvaravs/web-info/contents/
PROMPT_PATH_URL=https://api.github.com/repos/reinisvaravs/web-info/contents/walle-config/system-prompt.txt
DATABASE_URL=
DEV=true
PORT=8383
PROD_FRONTEND_URL=
DEV_FRONTEND_URL=http://localhost:3000
OPENAI_MODEL=gpt-3.5-turbo
```

### 4. Set Up the Database

This project uses PostgreSQL with the `pgvector` extension for vector search.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE vectors (
    id serial PRIMARY KEY,
    file_name text,
    chunk text,
    embedding_vector vector(3872),
    created_at timestamp
);

CREATE TABLE user_memory (
    user_id text,
    memory jsonb
);

CREATE TABLE file_hashes (
    file_name text,
    hash text
);

CREATE TABLE bot_stats (
    stat_key text,
    value double precision
);

CREATE TABLE audit_log (
    user_id text,
    username text,
    user_query text,
    bot_response text,
    timestamp timestamp
);
```

### 5. Start the Server

```bash
npm start
```

The API will be available at [http://localhost:8383](http://localhost:8383).

---

## API Endpoints

### `POST /api/message`

Send a user message to the backend and get a response from the chatbot.

**Request Body:**

```json
{
  "userId": "string",
  "username": "string",
  "content": "string",
  "model": "string (optional)",
  "language": "en" // or "lv"
}
```

**Response:**

- Returns the chatbot's response to the user message.

---

### `GET /`

Health check endpoint. Returns a simple message if the API is online.

---

## Security & Guardrails

- Blocks unsafe, inappropriate, or out-of-scope questions (e.g., medical, legal, personal data, violence, jailbreaking, etc.).
- Guardrails are enforced in code using robust regex patterns.
- Attempts to bypass or jailbreak the system are also blocked.
- Only blocked queries receive a generic safe response:  
  `Sorry, I can't help with that.`

---

## Knowledge Management

- The bot’s knowledge is sourced from files in a specified GitHub repository.
- Supported file types: `.txt`, `.md`, `.csv`, `.html`, `.json`, `.docx`, `.pdf`, `.xlsx`, `.yaml`, `.yml`
- Knowledge and system prompt are auto-refreshed every 10 minutes.

---

## Contributing

Contributions are welcome! If you have suggestions or find bugs, please open an issue or submit a pull request.

> **Note:** No `CONTRIBUTING.md` or `CODE_OF_CONDUCT.md` is present yet. For now, please follow standard open source etiquette.

---

## License

> **No license specified.**
> If you intend to open source this project, please add a `LICENSE` file (e.g., MIT, Apache 2.0, GPL) and update the `package.json` accordingly.

---

## Author

- **Reinis Varavs**
- 🌐 [reinisvaravs.com](https://reinisvaravs.com)
- 💻 [GitHub: reinisvaravs](https://github.com/reinisvaravs)

---

## Acknowledgements

- Powered by [OpenAI](https://openai.com/)
- Uses [pgvector](https://github.com/pgvector/pgvector) for vector search in PostgreSQL
