// index.js — Dialled Job Board
// Packages: discord.js, dotenv, express, cors, pg

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");

// ── Database ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          SERIAL PRIMARY KEY,
      title       TEXT        NOT NULL,
      company     TEXT        NOT NULL,
      pay_range   TEXT,
      url         TEXT,
      description TEXT,
      role_type   TEXT        NOT NULL CHECK (role_type IN ('setting','closing')),
      status      TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','filled','expired')),
      posted_by   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_channels (
      id         SERIAL PRIMARY KEY,
      channel_id TEXT        NOT NULL UNIQUE,
      label      TEXT,
      active     BOOLEAN     DEFAULT TRUE,
      added_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("✅ DB ready");
}

runMigrations().catch((e) => console.error("DB setup error:", e));

// ── Config ───────────────────────────────────────────────
const JOB_BOARD_CHANNEL = process.env.JOB_BOARD_CHANNEL_ID;
const PORTAL_API_KEY    = process.env.PORTAL_API_KEY;

// ── API key middleware ────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!PORTAL_API_KEY) return next();
  if (req.headers["x-api-key"] !== PORTAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// ── Discord job embed ─────────────────────────────────────
async function postJobToDiscord(job) {
  if (!JOB_BOARD_CHANNEL) return;
  try {
    const channel   = await client.channels.fetch(JOB_BOARD_CHANNEL);
    const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
    const color     = job.role_type === "closing"  ? 0xE24B4A : 0x5865F2;

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(job.title)
          .addFields(
            { name: "🏢 Company",     value: job.company,                                               inline: true  },
            { name: "💰 Pay Range",   value: job.pay_range   || "Not specified",                        inline: true  },
            { name: "🔗 Apply",       value: job.url         ? `[Click here](${job.url})` : "No link",  inline: true  },
            { name: "📋 Description", value: job.description || "No description provided",              inline: false },
          )
          .setColor(color)
          .setFooter({ text: `${roleLabel} • Posted via Dialled Portal` })
          .setTimestamp(),
      ],
    });
  } catch (err) {
    console.error("Job Discord post error:", err.message);
  }
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/",       (_, res) => res.send("Dialled Job Board is running 💼"));
app.get("/health", (_, res) => res.json({ status: "ok" }));

// GET /api/jobs — active non-expired jobs, optional ?role_type=setting|closing
app.get("/api/jobs", requireApiKey, async (req, res) => {
  try {
    const { role_type } = req.query;
    const params = [];
    let query = `
      SELECT * FROM jobs
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    if (role_type === "setting" || role_type === "closing") {
      params.push(role_type);
      query += ` AND role_type = $${params.length}`;
    }
    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// POST /api/jobs — create a job and fire Discord embed
app.post("/api/jobs", requireApiKey, async (req, res) => {
  try {
    const { title, company, pay_range, url, description, role_type, posted_by, expires_at } = req.body;

    if (!title || !company || !role_type) {
      return res.status(400).json({ error: "title, company and role_type are required" });
    }
    if (role_type !== "setting" && role_type !== "closing") {
      return res.status(400).json({ error: "role_type must be 'setting' or 'closing'" });
    }

    const result = await pool.query(
      `INSERT INTO jobs (title, company, pay_range, url, description, role_type, posted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [title, company, pay_range || null, url || null, description || null, role_type, posted_by || null, expires_at || null]
    );

    const job = result.rows[0];
    await postJobToDiscord(job);
    res.status(201).json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// PATCH /api/jobs/:id/status — mark as active, filled, or expired
app.patch("/api/jobs/:id/status", requireApiKey, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "filled", "expired"].includes(status)) {
      return res.status(400).json({ error: "status must be active, filled, or expired" });
    }
    const result = await pool.query(
      "UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Job not found" });
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// GET /api/jobs/all — all jobs including filled/expired
app.get("/api/jobs/all", requireApiKey, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM jobs ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on port ${PORT}`));

// ── Discord client (post-only, no commands) ───────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`✅ Discord bot ready: ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
