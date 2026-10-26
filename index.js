// index.js — Dialled Job Board + Tiers + #job-tips vision
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
      tier        TEXT        NOT NULL DEFAULT 'standard' CHECK (tier IN ('premium','standard','entry')),
      status      TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','filled','expired')),
      posted_by   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    )
  `);
  // Add tier column if upgrading from old schema
  await pool.query(`
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard'
  `).catch(() => {});
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

// Premium flow: anything posted in #premium-job-tips (text and/or screenshots,
// by anyone) is auto-approved and posted straight to #premium-board.
// IDs come from Railway env vars; if those are missing, the bot finds the
// channels by name on startup (e.g. "premium-job-tips" / "premium-board").
const cleanId = (v) => (v || "").replace(/[^0-9]/g, "") || null; // strips spaces, quotes, <#...>
let PREMIUM_TIPS_CHANNEL  = cleanId(process.env.PREMIUM_TIPS_CHANNEL_ID);
let PREMIUM_BOARD_CHANNEL = cleanId(process.env.PREMIUM_BOARD_CHANNEL_ID);

// ── Tier config ───────────────────────────────────────────
const TIERS = {
  premium:  { label: "💎 Premium",  color: 0xFFD700, description: "Top paying, competitive roles"    },
  standard: { label: "🔥 Standard", color: 0xE24B4A, description: "Mid-level roles"                  },
  entry:    { label: "🌱 Entry",    color: 0x57F287, description: "Starting out, beginner friendly"  },
};

// ── Claude vision — extract job from image ───────────────
async function extractJobFromImage(imageUrl) {
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
  "role_type": "closing or setting — closing if they need closers/sales, setting if they need setters/appointment setters, default to closing if unclear",
  "tier": "premium, standard, or entry — premium if high OTE or experienced only (e.g. $10k+/month, 2+ years required), entry if beginner friendly or no experience needed, standard for everything else"
}`,
          },
        ],
      }],
    }),
  });

  const data  = await response.json();
  const text  = data.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Post job to #job-board ────────────────────────────────
async function postJobToDiscord(job) {
  if (!JOB_BOARD_CHANNEL) return;
  const channel   = await client.channels.fetch(JOB_BOARD_CHANNEL);
  const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
  const tier      = TIERS[job.tier] || TIERS.standard;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(job.title)
        .addFields(
          { name: "🏢 Company",     value: job.company,                                              inline: true  },
          { name: "💰 Pay Range",   value: job.pay_range   || "Not specified",                       inline: true  },
          { name: "🏷️ Tier",        value: tier.label,                                               inline: true  },
          { name: "🔗 Apply",       value: job.url         ? `[Click here](${job.url})` : "No link", inline: true  },
          { name: "📋 Description", value: job.description || "No description provided",             inline: false },
        )
        .setColor(tier.color)
        .setFooter({ text: `${roleLabel} • ${tier.label} • Posted via Dialled Portal` })
        .setTimestamp(),
    ],
  });
}

// ── Premium: helpers ──────────────────────────────────────
const URL_REGEX = /https?:\/\/[^\s<>()\[\]"'`]+/gi;

// Pull links out of the original message exactly as written (minus trailing
// punctuation and Discord's <...> no-embed wrapper) so they are never rewritten.
function extractLinksVerbatim(text) {
  if (!text) return [];
  const found = text.match(URL_REGEX) || [];
  return [...new Set(found.map(u => u.replace(/[.,;:!?*_~]+$/, "")))];
}

function clip(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function formatApplyField(url) {
  if (!url) return "No link";
  if (/^https?:\/\//i.test(url)) return clip(`[Click here](${url})\n${url}`, 1024);
  return clip(url, 1024); // e.g. "DM @john on IG" — show as plain text
}

// Pull every top-level {...} object out of a model reply, ignoring any text
// around them. Handles one object, an object holding a "jobs" array, or
// several objects back to back.
function parseJsonObjects(raw) {
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && depth > 0 && --depth === 0) {
      try { objects.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* skip bad chunk */ }
    }
  }
  return objects;
}

// Ask Claude to split a premium tip (text and/or images) into one or more job posts.
async function extractJobsFromTip({ text, imageUrls }) {
  const content = [];

  for (const imageUrl of imageUrls) {
    const imageRes  = await fetch(imageUrl);
    const arrayBuf  = await imageRes.arrayBuffer();
    const mediaType = (imageRes.headers.get("content-type") || "image/png").split(";")[0];
    content.push({
      type:   "image",
      source: { type: "base64", media_type: mediaType, data: Buffer.from(arrayBuf).toString("base64") },
    });
  }

  // Number the lines so Claude can say exactly where each job starts and stops
  const numbered = text
    ? text.split("\n").map((line, i) => `${String(i + 1).padStart(3, " ")}| ${line}`).join("\n")
    : "";

  content.push({
    type: "text",
    text: `You are converting job tips posted in a Discord channel into structured job posts.
The tip may be plain text, one or more screenshots, or both.

IMPORTANT: a single tip often contains SEVERAL separate jobs. Recruiters post each job as its own block of roughly 3-8 lines (usually starting with a heading like "Hiring Closer:" / "Setter needed" / a company or offer name, followed by OTE, ticket price, requirements, link, etc.), then the next job starts underneath. Split the tip into one entry per distinct job. Never merge two jobs into one entry, and never split one job into two.${numbered ? `

Message text (line numbers on the left are for reference only, they are not part of the text):
"""
${numbered}
"""` : ""}

Respond ONLY with one JSON object in this exact shape, no other text, no markdown backticks:
{
  "jobs": [
    {
      "start_line": "number — first line of this job's block in the message text (null if the job only appears in a screenshot)",
      "end_line": "number — last line of this job's block (null if screenshot only)",
      "title": "job title or role name",
      "company": "company, offer or person hiring, use 'Unknown' if not found",
      "pay_range": "what the rep earns for THIS job only (OTE, salary, base + commission), written as in the post, e.g. \"$8K to $10K/mo\". Do NOT include ticket prices, cash collected or program prices here. null if not mentioned",
      "url": "application link or contact method for THIS job, copied character-for-character exactly as written, otherwise null",
      "description": "a clean 1-3 sentence summary of this role and its requirements (include ticket price / cash collected if given)",
      "role_type": "closing or setting — closing if they need closers/sales, setting if they need setters/appointment setters, default to closing if unclear",
      "monthly_ote": "number or null — the TOP of this job's advertised monthly earnings/OTE as a plain number with no symbols or commas (e.g. \"$8K to $10K/mo\" → 10000, \"$15k-25k\" → 25000). Convert yearly ÷12 and weekly ×4.33. Never use ticket prices, cash collected or program prices — only what the rep earns. null if this job states no earnings figure"
    }
  ]
}

If the tip contains no job opportunity at all (e.g. casual chat like "thanks" or "lol"), respond with exactly: {"jobs": []}`,
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-opus-4-5",
      max_tokens: 8000,
      messages:   [{ role: "user", content }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${data.error?.message || JSON.stringify(data)}`);
  const raw = data.content?.map(c => c.text || "").join("") || "";

  const objects = parseJsonObjects(raw);
  if (!objects.length) throw new Error("AI didn't return job details");
  // Accept {"jobs":[...]} or loose job objects back to back
  const jobs = objects.flatMap(o => Array.isArray(o.jobs) ? o.jobs : (o.title ? [o] : []));
  return jobs.filter(j => j && j.title && j.is_job !== false);
}

// Read the highest monthly earnings figure out of free text like
// "$8K to $10K/mo", "15k-25k OTE", "$120,000/yr", "$2.5k per week".
function parseMonthlyOte(str) {
  if (str === null || str === undefined) return null;
  if (typeof str === "number") return str > 0 ? str : null;
  const t = String(str).toLowerCase().replace(/,/g, "");
  const nums = [...t.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/g)]
    .map(m => parseFloat(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1000000 : 1))
    .filter(n => n >= 500); // ignore stray small numbers (e.g. "10%", "2 years")
  if (!nums.length) return null;
  let top = Math.max(...nums);
  if (/(\/|per|a|an)\s*(yr|year|annum)|annual|yearly|p\.?a\.?\b/.test(t)) top /= 12;
  else if (/(\/|per|a)\s*(wk|week)|weekly/.test(t)) top *= 4.33;
  return Math.round(top);
}

// Grade a premium-board offer by monthly OTE:
//   under $5k/mo     → entry    (green)
//   $5k up to $15k   → standard (red)
//   $15k+/mo         → premium  (gold)
// No earnings figure at all → standard.
function gradePremiumTier(job) {
  // Prefer our own reading of the pay text; fall back to the AI's number
  const ote = parseMonthlyOte(job.pay_range) ?? parseMonthlyOte(job.monthly_ote);
  job.monthly_ote = ote;
  if (!ote) return "standard";
  if (ote < 5000) return "entry";
  if (ote >= 15000) return "premium";
  return "standard";
}

// Post a premium job embed to #premium-board
async function postPremiumJobToDiscord(job, sourceMessage) {
  const channel   = await client.channels.fetch(PREMIUM_BOARD_CHANNEL);
  const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
  const tier      = TIERS[job.tier] || TIERS.standard;

  const fields = [
    { name: "🏢 Company",     value: clip(job.company || "Unknown", 1024),             inline: true  },
    { name: "💰 Pay Range",   value: clip(job.pay_range || "Not specified", 1024),     inline: true  },
    { name: "🏷️ Tier",        value: tier.label,                                       inline: true  },
    { name: "🔗 Apply",       value: formatApplyField(job.url),                        inline: false },
    { name: "📋 Description", value: clip(job.description || "No description provided", 1024), inline: false },
  ];
  if (job.extra_links?.length) {
    fields.push({ name: "🔗 Other Links", value: clip(job.extra_links.join("\n"), 1024), inline: false });
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(clip(job.title || "Premium Role", 256))
        .addFields(fields)
        .setColor(tier.color)
        .setFooter({ text: `${roleLabel} • ${tier.label} • Tip from ${sourceMessage.author.username}` })
        .setTimestamp(),
    ],
  });
}

// Handle a message in #premium-job-tips: split into jobs → post each → save.
// No approval step.
async function handlePremiumTip(message) {
  // Support Discord's native "Forward" feature (content lives in messageSnapshots)
  const snapshots = [...(message.messageSnapshots?.values?.() || [])];
  const texts = [message.content, ...snapshots.map(s => s.content)].filter(Boolean);
  const attachments = [
    ...message.attachments.values(),
    ...snapshots.flatMap(s => [...(s.attachments?.values?.() || [])]),
  ];

  const text      = texts.join("\n\n").trim();
  const imageUrls = attachments.filter(a => a.contentType?.startsWith("image/")).map(a => a.url);

  if (!text && !imageUrls.length) return; // nothing to work with (e.g. sticker)

  await message.react("🔍").catch(() => {});
  const clearSearching = () => message.reactions.cache.get("🔍")?.users.remove(client.user.id).catch(() => {});

  let jobs;
  try {
    jobs = await extractJobsFromTip({ text, imageUrls });
  } catch (err) {
    console.error("Premium tip extraction error:", err);
    await clearSearching();
    await message.react("❌").catch(() => {});
    await message.reply(`❌ Couldn't read this tip: ${clip(err.message || String(err), 300)}`).catch(() => {});
    return;
  }
  await clearSearching();
  if (!jobs.length) return; // casual chat — ignore quietly

  // Links are always taken verbatim from the original message, scoped to each
  // job's own block of lines so they never get attached to the wrong job.
  const lines       = text.split("\n");
  const allLinks    = extractLinksVerbatim(text);
  const claimed     = new Set();
  for (const job of jobs) {
    const s = parseInt(job.start_line, 10), e = parseInt(job.end_line, 10);
    if (s >= 1 && e >= s) {
      job._links = extractLinksVerbatim(lines.slice(s - 1, e).join("\n"));
      job._links.forEach(l => claimed.add(l));
    } else {
      job._links = [];
    }
  }
  // Links outside every job block (e.g. one "apply here" link at the bottom)
  // are shared with any job that has no link of its own.
  const shared = allLinks.filter(l => !claimed.has(l));

  let posted = 0;
  const failures = [];
  for (const job of jobs) {
    try {
      let links = job._links.length ? job._links : shared;
      // If Claude's link appears verbatim in the message, keep it first
      if (job.url && links.includes(job.url)) links = [job.url, ...links.filter(l => l !== job.url)];
      if (links.length) {
        job.url         = links[0];
        job.extra_links = links.slice(1);
      } else if (job.url && /^https?:\/\//i.test(job.url) && !text.includes(job.url) && text) {
        // Claude produced a URL that isn't in the message text — don't trust it
        job.url = null;
      }
      delete job._links;

      job.tier      = gradePremiumTier(job);
      job.role_type = job.role_type === "setting" ? "setting" : "closing";
      job.posted_by = `premium-tips:${message.author.username}`;
      console.log(`Premium tip graded: "${job.title}" | pay: ${job.pay_range} | monthly OTE: ${job.monthly_ote} → ${job.tier}`);

      // Post first so a DB hiccup never blocks the board
      await postPremiumJobToDiscord(job, message);
      posted++;
      await saveJobToDB(job).catch(err => console.error("Premium tip DB save failed (posted anyway):", err));
    } catch (err) {
      console.error(`Premium tip post error (${job.title}):`, err);
      failures.push(`${job.title}: ${err.message || err}`);
    }
  }

  if (posted) await message.react("✅").catch(() => {});
  if (failures.length) {
    await message.react("❌").catch(() => {});
    await message.reply(clip(`❌ Posted ${posted}/${jobs.length} jobs. Failed:\n• ${failures.join("\n• ")}`, 1900)).catch(() => {});
  }
}

// ── Save job to database ──────────────────────────────────
async function saveJobToDB(job) {
  const result = await pool.query(
    `INSERT INTO jobs (title, company, pay_range, url, description, role_type, tier, posted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [job.title, job.company, job.pay_range || null, job.url || null,
     job.description || null, job.role_type, job.tier || "standard", job.posted_by || "job-tips"]
  );
  return result.rows[0];
}

// ── Build preview embed + buttons ────────────────────────
function buildPreviewEmbed(job) {
  const roleLabel = job.role_type === "closing" ? "🔒 Closing Role" : "📞 Setting Role";
  const tier      = TIERS[job.tier] || TIERS.standard;

  const embed = new EmbedBuilder()
    .setTitle(`📋 Preview — ${job.title}`)
    .setDescription("Claude extracted the following details. Approve, edit, or discard.")
    .addFields(
      { name: "🏢 Company",     value: job.company,                                              inline: true  },
      { name: "💰 Pay Range",   value: job.pay_range   || "Not specified",                       inline: true  },
      { name: "🏷️ Tier",        value: tier.label,                                               inline: true  },
      { name: "🔗 Apply",       value: job.url         ? `[Click here](${job.url})` : "No link", inline: true  },
      { name: "📋 Description", value: job.description || "No description provided",             inline: false },
      { name: "🏷️ Role Type",   value: roleLabel,                                                inline: true  },
    )
    .setColor(tier.color)
    .setFooter({ text: "Only you can see this — approve, edit, or discard" });

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

// ── Pending jobs store ────────────────────────────────────
const pendingJobs = new Map();

// ── Discord client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Find a text channel across all servers the bot is in, by name keywords
function findChannelByName(test) {
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(c => c.isTextBased?.() && test(c.name.toLowerCase()));
    if (ch) return ch.id;
  }
  return null;
}

async function checkPremiumSetup() {
  if (!PREMIUM_TIPS_CHANNEL) {
    PREMIUM_TIPS_CHANNEL = findChannelByName(n => n.includes("premium") && n.includes("tip"));
    if (PREMIUM_TIPS_CHANNEL) console.log(`ℹ️ PREMIUM_TIPS_CHANNEL_ID not set — found tips channel by name: ${PREMIUM_TIPS_CHANNEL}`);
  }
  if (!PREMIUM_BOARD_CHANNEL) {
    PREMIUM_BOARD_CHANNEL = findChannelByName(n => n.includes("premium") && n.includes("board"));
    if (PREMIUM_BOARD_CHANNEL) console.log(`ℹ️ PREMIUM_BOARD_CHANNEL_ID not set — found board channel by name: ${PREMIUM_BOARD_CHANNEL}`);
  }
  if (!PREMIUM_TIPS_CHANNEL || !PREMIUM_BOARD_CHANNEL) {
    console.warn(`⚠️ Premium flow DISABLED — tips channel: ${PREMIUM_TIPS_CHANNEL || "NOT FOUND"}, board channel: ${PREMIUM_BOARD_CHANNEL || "NOT FOUND"}. Set PREMIUM_TIPS_CHANNEL_ID and PREMIUM_BOARD_CHANNEL_ID in Railway.`);
    return;
  }

  // Verify the bot can actually see/post in both channels
  const needs = {
    [PREMIUM_TIPS_CHANNEL]:  ["ViewChannel", "ReadMessageHistory", "AddReactions", "SendMessages"],
    [PREMIUM_BOARD_CHANNEL]: ["ViewChannel", "SendMessages", "EmbedLinks"],
  };
  for (const [id, perms] of Object.entries(needs)) {
    try {
      const ch      = await client.channels.fetch(id);
      const missing = perms.filter(p => !ch.permissionsFor(client.user)?.has(p));
      if (missing.length) console.warn(`⚠️ Bot is missing permissions in #${ch.name}: ${missing.join(", ")}`);
      else console.log(`✅ Premium channel OK: #${ch.name} (${id})`);
    } catch (err) {
      console.warn(`⚠️ Bot can't access channel ${id} — wrong ID or the bot can't see it: ${err.message}`);
    }
  }
}

client.once("ready", async () => {
  console.log(`✅ Discord bot ready: ${client.user.tag}`);
  await checkPremiumSetup().catch(err => console.error("Premium setup check failed:", err));
});

// ── Watch #premium-job-tips — auto-approve to #premium-board ──
client.on("messageCreate", async (message) => {
  if (!PREMIUM_TIPS_CHANNEL || !PREMIUM_BOARD_CHANNEL) return;
  // Match the channel itself, or a thread/forum post inside it
  const inTips = message.channelId === PREMIUM_TIPS_CHANNEL
              || message.channel?.parentId === PREMIUM_TIPS_CHANNEL;
  if (!inTips) return;
  if (message.author.id === client.user.id) return; // never loop on our own messages
  await handlePremiumTip(message);
});

// ── Watch #job-tips for images ────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.channelId !== JOB_TIPS_CHANNEL) return;
  if (message.author.bot) return;

  const attachment = message.attachments.find(a =>
    a.contentType?.startsWith("image/")
  );

  if (!attachment) {
    await message.reply("👋 Post a screenshot of the job and I'll extract the details automatically.");
    return;
  }

  const thinking = await message.reply("🔍 Reading the image...");

  try {
    const job = await extractJobFromImage(attachment.url);
    const { embed, buttons } = buildPreviewEmbed(job);
    await thinking.delete();

    const preview = await message.channel.send({
      embeds: [embed],
      components: [buttons],
    });

    pendingJobs.set(preview.id, job);

    // Auto-discard after 30 minutes
    setTimeout(() => {
      if (pendingJobs.has(preview.id)) {
        pendingJobs.delete(preview.id);
        preview.edit({ components: [] }).catch(() => {});
      }
    }, 30 * 60 * 1000);

  } catch (err) {
    console.error("Image extraction error:", err);
    await thinking.edit("❌ Couldn't read that image. Try a clearer screenshot or post the details as text.");
  }
});

// ── Handle buttons + modal ────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // Approve
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
      await interaction.followUp({ content: "❌ Something went wrong.", ephemeral: true });
    }
  }

  // Discard
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

  // Edit — open modal
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
          .setCustomId("edit_tier_and_description")
          .setLabel("Tier (premium/standard/entry) + Description")
          .setStyle(TextInputStyle.Paragraph)
          .setValue(`TIER: ${job.tier || "standard"}\n\n${job.description || ""}`)
          .setRequired(false)
          .setPlaceholder("First line: TIER: premium/standard/entry\nThen description below")
      ),
    );

    await interaction.showModal(modal);
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("edit_modal_")) {
    const messageId = interaction.customId.replace("edit_modal_", "");
    const job       = pendingJobs.get(messageId);
    if (!job) return interaction.reply({ content: "⚠️ This preview has expired.", ephemeral: true });

    const tierAndDesc = interaction.fields.getTextInputValue("edit_tier_and_description");

    // Parse tier from first line, description from the rest
    const lines    = tierAndDesc.split("\n");
    const tierLine = lines[0].replace("TIER:", "").trim().toLowerCase();
    const desc     = lines.slice(2).join("\n").trim();

    job.title       = interaction.fields.getTextInputValue("edit_title");
    job.company     = interaction.fields.getTextInputValue("edit_company");
    job.pay_range   = interaction.fields.getTextInputValue("edit_pay")  || null;
    job.url         = interaction.fields.getTextInputValue("edit_url")   || null;
    job.tier        = TIERS[tierLine] ? tierLine : "standard";
    job.description = desc || null;
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

// GET /api/jobs — supports ?role_type= and ?tier= filters
app.get("/api/jobs", requireApiKey, async (req, res) => {
  try {
    const { role_type, tier } = req.query;
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
    if (["premium", "standard", "entry"].includes(tier)) {
      params.push(tier);
      query += ` AND tier = $${params.length}`;
    }
    query += " ORDER BY CASE tier WHEN 'premium' THEN 1 WHEN 'standard' THEN 2 WHEN 'entry' THEN 3 END, created_at DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// POST /api/jobs
app.post("/api/jobs", requireApiKey, async (req, res) => {
  try {
    const { title, company, pay_range, url, description, role_type, tier, posted_by, expires_at } = req.body;
    if (!title || !company || !role_type) {
      return res.status(400).json({ error: "title, company and role_type are required" });
    }
    if (!["setting", "closing"].includes(role_type)) {
      return res.status(400).json({ error: "role_type must be 'setting' or 'closing'" });
    }
    const validTier = ["premium", "standard", "entry"].includes(tier) ? tier : "standard";
    const result = await pool.query(
      `INSERT INTO jobs (title, company, pay_range, url, description, role_type, tier, posted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, company, pay_range || null, url || null, description || null,
       role_type, validTier, posted_by || null, expires_at || null]
    );
    const job = result.rows[0];
    await postJobToDiscord(job);
    res.status(201).json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// PATCH /api/jobs/:id/status
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

// GET /api/jobs/all
app.get("/api/jobs/all", requireApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM jobs ORDER BY CASE tier WHEN 'premium' THEN 1 WHEN 'standard' THEN 2 WHEN 'entry' THEN 3 END, created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
