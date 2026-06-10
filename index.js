// index.js — Dialled Job Board + #job-tips image reader
// Packages: discord.js, dotenv, express, cors, pg

require("dotenv").config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
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
const JOB_TIPS_CHANNEL  = "1514126756766945290";
const ADMIN_ROLE_ID     = "1506575371783503983";
const JOB_BOARD_CHANNEL = process.env.JOB_BOARD_CHANNEL_ID;
const PORTAL_API_KEY    = process.env.PORTAL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Claude vision — extract job from image ───────────────
async function extractJobFromImage(imageUrl) {
  // Download image and convert to base64
  const imageRes  = await fetch(imageUrl);
  const arrayBuf  = await imageRes.arrayBuffer();
  const base64    = Buffer.from(arrayBuf).toString("base64");
  const mediaType = imageRes.headers.get("content-type") || "image/png";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-opus-4-5",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type:   "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: `Extract job details from this image and respond ONLY with a JSON object, no other text, no markdown backticks.

The JSON must have exactly these fields:
{
  "title": "job title or role name",
  "company": "company or person hiring, use 'Unknown' if not found",
  "pay_range": "salary or OTE if mentioned, otherwise null",
  "url": "application link or contact method if mentioned, otherwise null",
  "description": "a clean 1-3 sentence summary of the role and requirements",
  "role_type": "closing or setting — closing if they need closers/sales, setting if they need setters/appointment setters, default to closing if unclear"
}`,
          },
        ],
      }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "";

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Post job to #job-board channel ───────────────────────
async function postJobToDiscord(job) {
  if (!JOB_BOARD_CHANNEL) return;
  const channel   = await client.channels.fetch(JOB_BOARD_CHANNEL);
  const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
  const color     = job.role_type === "closing"  ? 0xE24B4A : 0x5865F2;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(job.title)
        .addFields(
          { name: "🏢 Company",     value: job.company,                                              inline: true  },
          { name: "💰 Pay Range",   value: job.pay_range   || "Not specified",                       inline: true  },
          { name: "🔗 Apply",       value: job.url         ? `[Click here](${job.url})` : "No link", inline: true  },
          { name: "📋 Description", value: job.description || "No description provided",             inline: false },
        )
        .setColor(color)
        .setFooter({ text: `${roleLabel} • Posted via Dialled Portal` })
        .setTimestamp(),
    ],
  });
}

// ── Save job to database ──────────────────────────────────
async function saveJobToDB(job) {
  const result = await pool.query(
    `INSERT INTO jobs (title, company, pay_range, url, description, role_type, posted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [job.title, job.company, job.pay_range || null, job.url || null,
     job.description || null, job.role_type, job.posted_by || "job-tips"]
  );
  return result.rows[0];
}

// ── Build preview embed + action buttons ─────────────────
function buildPreviewEmbed(job) {
  const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
  const color     = job.role_type === "closing"  ? 0xE24B4A : 0x5865F2;

  const embed = new EmbedBuilder()
    .setTitle(`📋 Preview — ${job.title}`)
    .setDescription("Claude extracted the following details. Approve, edit, or discard.")
    .addFields(
      { name: "🏢 Company",     value: job.company,                                              inline: true  },
      { name: "💰 Pay Range",   value: job.pay_range   || "Not specified",                       inline: true  },
      { name: "🔗 Apply",       value: job.url         ? `[Click here](${job.url})` : "No link", inline: true  },
      { name: "📋 Description", value: job.description || "No description provided",             inline: false },
      { name: "🏷️ Role Type",   value: roleLabel,                                                inline: true  },
    )
    .setColor(color)
    .setFooter({ text: "Only you can see this — react to approve, edit, or discard" });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("approve_job")
      .setLabel("✅ Approve & Post")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("edit_job")
      .setLabel("✏️ Edit Details")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("discard_job")
      .setLabel("❌ Discard")
      .setStyle(ButtonStyle.Danger),
  );

  return { embed, buttons };
}

// ── In-memory store for pending jobs ─────────────────────
// key = preview message ID, value = extracted job object
const pendingJobs = new Map();

// ── Discord client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ Discord bot ready: ${client.user.tag}`);
});

// ── Watch #job-tips for images ────────────────────────────
client.on("messageCreate", async (message) => {
  // Only watch the job-tips channel, ignore bots
  if (message.channelId !== JOB_TIPS_CHANNEL) return;
  if (message.author.bot) return;

  const attachment = message.attachments.find(a =>
    a.contentType?.startsWith("image/")
  );

  if (!attachment) {
    // Not an image — send a helpful nudge
    await message.reply({
      content: "👋 Post a screenshot of the job and I'll extract the details automatically.",
      ephemeral: false,
    });
    return;
  }

  // Acknowledge receipt
  const thinking = await message.reply("🔍 Reading the image...");

  try {
    const job = await extractJobFromImage(attachment.url);
    const { embed, buttons } = buildPreviewEmbed(job);

    // Delete the "reading..." message
    await thinking.delete();

    // Post the preview — visible to anyone in this private channel (just you)
    const preview = await message.channel.send({
      embeds: [embed],
      components: [buttons],
    });

    // Store the extracted job against the preview message ID
    pendingJobs.set(preview.id, job);

    // Auto-discard after 30 minutes if no action taken
    setTimeout(() => {
      if (pendingJobs.has(preview.id)) {
        pendingJobs.delete(preview.id);
        preview.edit({
          embeds: [embed.setFooter({ text: "⏱️ Auto-discarded after 30 minutes" })],
          components: [],
        }).catch(() => {});
      }
    }, 30 * 60 * 1000);

  } catch (err) {
    console.error("Image extraction error:", err);
    await thinking.edit("❌ Couldn't read that image. Try a clearer screenshot or post the job details as text.");
  }
});

// ── Handle button clicks ──────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Approve button ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "approve_job") {
    const job = pendingJobs.get(interaction.message.id);
    if (!job) return interaction.reply({ content: "⚠️ This preview has expired.", ephemeral: true });

    await interaction.deferUpdate();
    try {
      await saveJobToDB(job);
      await postJobToDiscord(job);
      pendingJobs.delete(interaction.message.id);

      await interaction.message.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Posted to #job-board")
            .setDescription(`**${job.title}** at ${job.company} is now live.`)
            .setColor(0x3ba55d),
        ],
        components: [],
      });
    } catch (err) {
      console.error("Approve error:", err);
      await interaction.followUp({ content: "❌ Something went wrong posting the job.", ephemeral: true });
    }
  }

  // ── Discard button ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "discard_job") {
    pendingJobs.delete(interaction.message.id);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Discarded")
          .setDescription("This job was not posted.")
          .setColor(0x888888),
      ],
      components: [],
    });
  }

  // ── Edit button — opens modal ───────────────────────────
  if (interaction.isButton() && interaction.customId === "edit_job") {
    const job = pendingJobs.get(interaction.message.id);
    if (!job) return interaction.reply({ content: "⚠️ This preview has expired.", ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId(`edit_modal_${interaction.message.id}`)
      .setTitle("Edit Job Details");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("edit_title")
          .setLabel("Job Title")
          .setStyle(TextInputStyle.Short)
          .setValue(job.title)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("edit_company")
          .setLabel("Company")
          .setStyle(TextInputStyle.Short)
          .setValue(job.company)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("edit_pay")
          .setLabel("Pay Range")
          .setStyle(TextInputStyle.Short)
          .setValue(job.pay_range || "")
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("edit_url")
          .setLabel("Application Link")
          .setStyle(TextInputStyle.Short)
          .setValue(job.url || "")
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("edit_description")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setValue(job.description || "")
          .setRequired(false)
      ),
    );

    await interaction.showModal(modal);
  }

  // ── Modal submit — update job and re-show preview ───────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("edit_modal_")) {
    const messageId = interaction.customId.replace("edit_modal_", "");
    const job       = pendingJobs.get(messageId);
    if (!job) return interaction.reply({ content: "⚠️ This preview has expired.", ephemeral: true });

    // Update the stored job with edited values
    job.title       = interaction.fields.getTextInputValue("edit_title");
    job.company     = interaction.fields.getTextInputValue("edit_company");
    job.pay_range   = interaction.fields.getTextInputValue("edit_pay")        || null;
    job.url         = interaction.fields.getTextInputValue("edit_url")         || null;
    job.description = interaction.fields.getTextInputValue("edit_description") || null;
    pendingJobs.set(messageId, job);

    const { embed, buttons } = buildPreviewEmbed(job);

    await interaction.update({
      embeds:     [embed.setTitle(`📋 Preview (Edited) — ${job.title}`)],
      components: [buttons],
    });
  }
});

// ── API key middleware ────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!PORTAL_API_KEY) return next();
  if (req.headers["x-api-key"] !== PORTAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/",       (_, res) => res.send("Dialled Job Board is running 💼"));
app.get("/health", (_, res) => res.json({ status: "ok" }));

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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [title, company, pay_range || null, url || null, description || null,
       role_type, posted_by || null, expires_at || null]
    );
    const job = result.rows[0];
    await postJobToDiscord(job);
    res.status(201).json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

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

client.login(process.env.DISCORD_TOKEN);
