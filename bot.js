// ============================================================
//  StepOne WhatsApp AI Bot — v5.1 BUGFIX
//  ✅ Fixed history fetch (multi-endpoint retry + correct ms/s timestamps)
//  ✅ [Invalid Date] entries stripped on load, never written again
//  ✅ Message dedup (processedMsgIds set) — no more double-sends
//  ✅ Trivial client messages (Okay/👍/Setup) skipped — no false alerts
//  ✅ Stricter auto-reply gating (requests + ≤2 word msgs suppressed)
//  ✅ Comms context expanded to last 20 msgs — "who asked about X" works
//  ✅ Improved system prompt for context queries
// ============================================================

require("dotenv").config();
const express  = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const cron     = require("node-cron");
const mammoth  = require("mammoth");

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.path === "/webhook") {
      const raw = buf.toString();
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("🔔 WEBHOOK HIT | event:", JSON.parse(raw || "{}").event_type);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// ── Startup checks ───────────────────────────────────────────
console.log("🔑 ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅" : "❌ MISSING");
console.log("🔑 PERISKOPE_API_KEY:", process.env.PERISKOPE_API_KEY ? "✅" : "❌ MISSING");
console.log("📱 BOT PHONE        :", process.env.PERISKOPE_PHONE_ID);

const claude        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PERISKOPE_KEY = process.env.PERISKOPE_API_KEY;
const BOT_PHONE     = process.env.PERISKOPE_PHONE_ID;
const BOT_NAME      = "StepOne Assistant";

// ── DIRS ─────────────────────────────────────────────────────
const ATTACHMENTS_DIR = "./attachments";
const HISTORY_FILE    = "./chat_history.json";
if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// ── GROUP CONFIGURATION ──────────────────────────────────────
// Internal comms group — all client updates go HERE
const COMMS_GROUP = "120363408950002751@g.us";

// ── CLIENT GROUPS ─────────────────────────────────────────────
// Populated dynamically on startup via discoverClientGroups()
// Any group the bot is in — except COMMS_GROUP and EXCLUDED_GROUPS — becomes a client group
let CLIENT_GROUPS = {};   // { chatId: groupName }  — filled at runtime

// Groups to NEVER treat as client groups (add any internal/ops groups here)
const EXCLUDED_GROUPS = new Set([
  COMMS_GROUP,
  // "120363XXXXXXXXXX@g.us",  ← add other internal groups here if needed
]);

// ── Discover client groups from Periskope API ─────────────────
async function discoverClientGroups() {
  console.log("🔍 Discovering client groups from Periskope...");
  try {
    const res = await axios.get("https://api.periskope.app/v1/chats", {
      headers: { Authorization: `Bearer ${PERISKOPE_KEY}`, "x-phone": BOT_PHONE },
      timeout: 10000,
    });

    const chats = res.data?.chats || res.data?.data || res.data || [];
    const groups = chats.filter(c =>
      c.chat_id?.endsWith("@g.us") && !EXCLUDED_GROUPS.has(c.chat_id)
    );

    if (groups.length === 0) {
      console.warn("⚠️  No client groups found — check Periskope API or add groups manually");
      return;
    }

    CLIENT_GROUPS = {};
    for (const g of groups) {
      CLIENT_GROUPS[g.chat_id] = g.chat_name || g.name || g.chat_id;
    }

    console.log(`✅ Discovered ${Object.keys(CLIENT_GROUPS).length} client group(s):`);
    for (const [id, name] of Object.entries(CLIENT_GROUPS)) {
      console.log(`   📱 ${name} (${id})`);
    }
  } catch (err) {
    console.error("❌ Group discovery failed:", err.response?.data?.message || err.message);
    console.warn("⚠️  Falling back to hardcoded CLIENT_GROUPS if any are set");
  }
}

// ── ADMIN TEAM ───────────────────────────────────────────────
// specialisations: Claude uses this to pick who to tag
const ADMINS = {
  Satya: {
    phone:          "917731066049@c.us",
    specialisation: "technical issues, product bugs, API and module queries",
  },
  // Ravi: {
  //   phone:          "91XXXXXXXXXX@c.us",
  //   specialisation: "billing, payments, invoices",
  // },
  // Priya: {
  //   phone:          "91YYYYYYYYYY@c.us",
  //   specialisation: "onboarding, general support, scheduling",
  // },
};

// ── CONSTANTS ────────────────────────────────────────────────
const MAX_HISTORY       = 40;
const TRAFFIC_WINDOW_MS = 15 * 60 * 1000;
const TRAFFIC_THRESHOLD = 3;               // msgs before auto-summary fires
const SUMMARY_COOLDOWN  = TRAFFIC_WINDOW_MS;

// ── STATE ────────────────────────────────────────────────────
const trafficTracker  = {};   // { chatId: [ts, ts, ...] }
const chatHistory     = {};   // { chatId: [{role, content}] }
const summaryCooldown = {};
const processedMsgIds = new Set(); // dedup: prevents same webhook firing twice
const lastMsgId       = {};        // { chatId: messageId } — for quoting/tagging

// ── Load / Save history ──────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      // Strip [Invalid Date] entries left over from old bot runs
      for (const [chatId, msgs] of Object.entries(data)) {
        data[chatId] = msgs.filter(m => !m.content.startsWith("[Invalid Date]"));
      }
      Object.assign(chatHistory, data);
      const total = Object.values(chatHistory).reduce((a, b) => a + b.length, 0);
      console.log(`📂 Loaded: ${Object.keys(chatHistory).length} chats, ${total} messages`);
    } else {
      console.log("📂 No history file — starting fresh");
    }
  } catch (e) {
    console.error("❌ Load history failed:", e.message);
  }
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2)); }
  catch (e) { console.error("❌ Save history failed:", e.message); }
}
loadHistory();

// ────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────

function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

async function sendWhatsAppMessage(chatId, message, quotedMsgId = null) {
  try {
    const body = { chat_id: chatId, message };
    if (quotedMsgId) body.quoted_message_id = quotedMsgId;   // reply/tag support
    const res = await axios.post(
      "https://api.periskope.app/v1/messages/send",
      body,
      { headers: { Authorization: `Bearer ${PERISKOPE_KEY}`, "Content-Type": "application/json", "x-phone": BOT_PHONE } }
    );
    console.log(`✅ Sent to ${chatId} | queue: ${res.data?.queue_id}${quotedMsgId ? " (quoted)" : ""}`);
  } catch (err) {
    console.error(`❌ Send failed to ${chatId}:`, err.response?.data || err.message);
  }
}

function addToHistory(chatId, role, content) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role, content: `[${nowIST()}] ${content}` });
  if (chatHistory[chatId].length > MAX_HISTORY)
    chatHistory[chatId] = chatHistory[chatId].slice(-MAX_HISTORY);
  saveHistory();
}

function trackMessage(chatId) {
  const now = Date.now();
  if (!trafficTracker[chatId]) trafficTracker[chatId] = [];
  trafficTracker[chatId] = trafficTracker[chatId].filter(t => now - t < TRAFFIC_WINDOW_MS);
  trafficTracker[chatId].push(now);
  const count = trafficTracker[chatId].length;
  console.log(`📊 Traffic [${chatId}]: ${count} msgs in last 15 min`);
  return count >= TRAFFIC_THRESHOLD;
}

async function askClaude(messages, systemPrompt, maxTokens = 700) {
  const res = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  return res.content[0].text;
}

// ── Build admin list string for prompts ──────────────────────
function buildAdminList() {
  return Object.entries(ADMINS)
    .map(([name, a]) => `${name} (phone: ${a.phone}, handles: ${a.specialisation})`)
    .join("\n");
}

// ────────────────────────────────────────────────────────────
//  FILE HANDLER — PDF & Word analysis
// ────────────────────────────────────────────────────────────

/**
 * Downloads a file from url, saves to ./attachments/, returns { filePath, base64, mimeType }
 */
async function downloadAttachment(url, filename) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(ATTACHMENTS_DIR, `${Date.now()}_${safeFilename}`);
  const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000,
    headers: { Authorization: `Bearer ${PERISKOPE_KEY}` }
  });
  fs.writeFileSync(filePath, response.data);
  const base64 = Buffer.from(response.data).toString("base64");
  const mimeType = response.headers["content-type"] || "application/octet-stream";
  console.log(`📥 Downloaded: ${filePath} (${(response.data.byteLength / 1024).toFixed(1)} KB)`);
  return { filePath, base64, mimeType, buffer: Buffer.from(response.data) };
}

/**
 * Analyse a PDF via Claude's native document support
 */
async function analysePDF(base64Data, filename, senderName, groupName) {
  console.log(`📄 Analysing PDF: ${filename}`);
  const res = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64Data }
        },
        {
          type: "text",
          text: `This PDF was sent by "${senderName}" in client group "${groupName}".\n\n` +
                `Please provide:\n` +
                `1. A concise summary (3-5 bullet points) of the document content\n` +
                `2. Any action items or requests directed at StepOne\n` +
                `3. Urgency assessment: high / medium / low\n` +
                `4. Key numbers, dates, or deadlines mentioned\n\n` +
                `Be business-focused and concise.`
        }
      ]
    }]
  });
  return res.content[0].text;
}

/**
 * Analyse a Word (.docx) file using mammoth to extract text, then Claude
 */
async function analyseWordDoc(buffer, filename, senderName, groupName) {
  console.log(`📝 Analysing Word doc: ${filename}`);
  let text = "";
  try {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value.substring(0, 8000); // cap at ~8k chars
  } catch (e) {
    console.error("❌ mammoth extraction failed:", e.message);
    return "⚠️ Could not extract text from Word document.";
  }

  const analysisText = await askClaude(
    [{
      role: "user",
      content: `This Word document was sent by "${senderName}" in client group "${groupName}".\n\n` +
               `Document content:\n---\n${text}\n---\n\n` +
               `Please provide:\n` +
               `1. A concise summary (3-5 bullet points)\n` +
               `2. Any action items or requests directed at StepOne\n` +
               `3. Urgency: high / medium / low\n` +
               `4. Key numbers, dates, or deadlines mentioned`
    }],
    "You are a business analyst. Be concise and business-focused.",
    1000
  );
  return analysisText;
}

/**
 * Analyse an image via Claude Vision
 */
async function analyseImage(base64Data, mimeType, senderName, groupName, caption) {
  console.log(`🖼️  Analysing image (${mimeType})`);
  const res = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64Data }
        },
        {
          type: "text",
          text: `This image was sent by "${senderName}" in client group "${groupName}".` +
                (caption ? ` Caption: "${caption}"` : "") + `\n\n` +
                `Please provide:\n` +
                `1. What is shown in the image (describe clearly)\n` +
                `2. Business context — what is the client likely communicating?\n` +
                `3. Any text, numbers, dates, or error messages visible in the image\n` +
                `4. Action items or requests for StepOne\n` +
                `5. Urgency: high / medium / low\n\n` +
                `Be concise and business-focused.`
        }
      ]
    }]
  });
  return res.content[0].text;
}

/**
 * Fetch and analyse a URL / link shared by client
 */
async function analyseLink(url, senderName, groupName) {
  console.log(`🔗 Fetching link: ${url}`);
  let pageText = "";
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StepOneBot/1.0)" },
      maxContentLength: 500000,
    });
    // Strip HTML tags for a rough plain-text extract
    pageText = res.data
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .substring(0, 6000);
  } catch (err) {
    console.error(`❌ Could not fetch URL ${url}:`, err.message);
    return `⚠️ Could not read the page at ${url} (${err.message}). Please review manually.`;
  }

  return await askClaude(
    [{
      role: "user",
      content: `A link was shared by "${senderName}" in client group "${groupName}":\n${url}\n\n` +
               `Page content (extracted):\n---\n${pageText}\n---\n\n` +
               `Please provide:\n` +
               `1. What this page/link is about\n` +
               `2. Why the client likely shared it — what are they asking or showing?\n` +
               `3. Any action items for StepOne\n` +
               `4. Urgency: high / medium / low`
    }],
    "You are a business analyst reviewing client-shared links. Be concise.",
    800
  );
}

/**
 * Extract URLs from a message body
 */
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  return [...new Set(text.match(urlRegex) || [])];
}

/**
 * Main media/file/link analysis entry point
 */
async function handleFileAttachment(chatId, clientGroupName, senderName, data, messageText) {
  const mediaUrl = data.media_url || null;
  const filename = data.filename  || "attachment";
  const mimeType = data.mime_type || "";

  const isPDF   = mimeType.includes("pdf")   || filename.toLowerCase().endsWith(".pdf");
  const isWord  = mimeType.includes("word")  || filename.toLowerCase().match(/\.docx?$/);
  const isImage = mimeType.startsWith("image/") ||
                  /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(filename);

  // ── Links in message text ────────────────────────────────
  const urls = extractUrls(messageText || data.caption || "");
  if (urls.length > 0) {
    console.log(`🔗 Found ${urls.length} URL(s) in message`);
    for (const url of urls.slice(0, 3)) {  // max 3 links per message
      try {
        const linkAnalysis = await analyseLink(url, senderName, clientGroupName);
        addToHistory(chatId, "user",
          `[${senderName} shared link: ${url}]\nAnalysis:\n${linkAnalysis}`);
        await sendWhatsAppMessage(COMMS_GROUP,
          `🔗 *Link Shared — ${clientGroupName}*\n` +
          `👤 From: ${senderName}\n` +
          `🌐 ${url}\n\n` +
          `*Analysis:*\n${linkAnalysis.substring(0, 700)}${linkAnalysis.length > 700 ? "\n_(truncated)_" : ""}`
        );
      } catch (err) {
        console.error("❌ Link analysis failed:", err.message);
      }
    }
  }

  // ── No media URL — nothing left to download ──────────────
  if (!mediaUrl) {
    if (urls.length === 0) console.log("⚠️  No media URL and no links found");
    return;
  }

  // ── Download the file ────────────────────────────────────
  let downloaded;
  try {
    downloaded = await downloadAttachment(mediaUrl, filename);
  } catch (err) {
    console.error("❌ Download failed:", err.message);
    await sendWhatsAppMessage(COMMS_GROUP,
      `📎 *File Received — ${clientGroupName}*\n👤 ${senderName} | ${filename}\n⚠️ Download failed — review manually.`
    );
    return;
  }

  const { filePath, base64, buffer, mimeType: detectedMime } = downloaded;
  const resolvedMime = mimeType || detectedMime;

  let analysis = "";
  let icon = "📎";

  try {
    if (isPDF) {
      icon = "📄";
      analysis = await analysePDF(base64, filename, senderName, clientGroupName);
    } else if (isWord) {
      icon = "📝";
      analysis = await analyseWordDoc(buffer, filename, senderName, clientGroupName);
    } else if (isImage || resolvedMime.startsWith("image/")) {
      icon = "🖼️";
      // Normalise mime for Claude (must be image/jpeg, image/png, image/gif, image/webp)
      const claudeMime = resolvedMime.startsWith("image/") ? resolvedMime : "image/jpeg";
      const caption = data.caption || messageText || "";
      analysis = await analyseImage(base64, claudeMime, senderName, clientGroupName, caption);
    } else {
      console.log(`ℹ️  Unsupported file type: ${resolvedMime || filename} — logged only`);
      addToHistory(chatId, "user", `[${senderName} sent unsupported file: ${filename}]`);
      await sendWhatsAppMessage(COMMS_GROUP,
        `📎 *File Received — ${clientGroupName}*\n👤 ${senderName}\n📄 ${filename}\n` +
        `ℹ️ File type not auto-analysed (${resolvedMime || "unknown type"})`
      );
      return;
    }

    // Store in history
    addToHistory(chatId, "user",
      `[${senderName} sent ${isImage ? "image" : "file"}: ${filename}]\nAnalysis:\n${analysis}`);

    // Save backup
    const analysisPath = filePath.replace(/\.[^.]+$/, "") + "_analysis.txt";
    fs.writeFileSync(analysisPath,
      `File: ${filename}\nSender: ${senderName}\nGroup: ${clientGroupName}\nTime: ${nowIST()}\n\n${analysis}`);

    const urgencyLine = analysis.toLowerCase().includes("high") ? "🔴 HIGH urgency" : "🟡 Review needed";
    await sendWhatsAppMessage(COMMS_GROUP,
      `${icon} *${isImage ? "Image" : "File"} Received — ${clientGroupName}*\n` +
      `👤 From: ${senderName}\n` +
      `📄 ${filename}\n` +
      `${urgencyLine}\n\n` +
      `*Analysis:*\n${analysis.substring(0, 800)}${analysis.length > 800 ? "\n_(truncated — full saved)_" : ""}`
    );
    console.log(`✅ Analysed & backed up: ${filePath}`);

  } catch (err) {
    console.error("❌ Analysis failed:", err.message);
    await sendWhatsAppMessage(COMMS_GROUP,
      `${icon} *${clientGroupName}* — ${filename}\n👤 ${senderName}\n⚠️ Analysis failed: ${err.message}`
    );
  }
}

// ────────────────────────────────────────────────────────────
//  TRIVIAL MESSAGE FILTER — skip analysis for short acks
// ────────────────────────────────────────────────────────────
const CLIENT_TRIVIAL = [
  "okay","ok","sure","noted","thanks","👍","👌","done","yes","no",
  "hmm","k","got it","fine","🙏","ack","hi","hello","hey","bye",
  "noted, thanks","noted thanks","ok thanks","ok, thanks",
];
function isTrivialClientMessage(message) {
  if (!message) return false;
  const m = message.toLowerCase().trim();
  if (m.length <= 3) return true;
  if (CLIENT_TRIVIAL.includes(m)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────
//  SMART RESPONSE GATING
//  Auto-reply ONLY for standalone FAQs with no company context needed.
//  Single-word follow-ups, timeline questions, setup requests → human.
// ────────────────────────────────────────────────────────────
const SCHEDULING_KEYWORDS = [
  "connect","call","meeting","schedule","when","availability","available",
  "reschedule","slot","time","pm","am","tomorrow","today","catch up",
  "free","busy","zoom","meet","google meet","teams",
];
function isSchedulingQuestion(message) {
  if (!message) return false;
  const m = message.toLowerCase();
  return SCHEDULING_KEYWORDS.some(k => m.includes(k));
}

function shouldAutoReply(analysis, message) {
  if (!analysis.client_reply)           return false; // Claude gave no reply
  if (analysis.urgency === "high")      return false; // urgent → human
  if (analysis.type === "complaint")    return false; // complaints → human
  if (analysis.type === "request")      return false; // requests need human decision
  if (analysis.confidence !== "high")   return false; // not sure → don't reply
  // Single-word or very short messages are context-dependent — don't guess
  if (message && message.trim().split(/\s+/).length <= 2) return false;
  // Scheduling/meeting questions always need a human to confirm availability
  if (isSchedulingQuestion(message))    return false;
  return true;
}

// ────────────────────────────────────────────────────────────
//  CORE: Handle client group message
// ────────────────────────────────────────────────────────────
async function handleClientMessage(chatId, clientGroupName, senderName, message, data, msgId = null) {
  console.log(`\n🎯 CLIENT GROUP MESSAGE`);
  console.log(`   Group  : ${clientGroupName}`);
  console.log(`   From   : ${senderName}`);
  console.log(`   Message: ${message || "(no text)"}`);

  // ── File attachment? ─────────────────────────────────────
  const hasAttachment = !!(data.media_url || data.filename);
  if (hasAttachment) {
    await handleFileAttachment(chatId, clientGroupName, senderName, data, message);
    if (!message) return;
  }

  if (!message) return;

  // ── Plain text but contains a URL? Analyse the link ─────
  const inlineUrls = extractUrls(message);
  if (!hasAttachment && inlineUrls.length > 0) {
    await handleFileAttachment(chatId, clientGroupName, senderName, data, message);
    // Continue — also process the message text normally below
  }

  // ── Trivial ack from client? Skip full analysis ──────────
  if (isTrivialClientMessage(message)) {
    console.log(`⏭️  Trivial client message ("${message}") — logging only`);
    addToHistory(chatId, "user", `[${senderName}]: ${message}`);
    return;
  }

  addToHistory(chatId, "user", `[${senderName}]: ${message}`);
  const isHeavyTraffic = trackMessage(chatId);

  const analysisPrompt =
`You are StepOne Assistant monitoring WhatsApp client groups.

A message arrived in client group "${clientGroupName}":
Sender: ${senderName}
Message: "${message}"

Recent conversation history (last 5 messages):
${(chatHistory[chatId] || []).slice(-5).map(m => m.content).join("\n")}

Available admins and their specialisations:
${buildAdminList()}

Your tasks:
1. Classify the message type: question | complaint | update | request | general
2. Assess urgency: high | medium | low
3. Pick the best admin to handle it based on their specialisation (or "all")
4. Write a brief internal alert for the comms group (2-3 lines)
5. If it is a simple factual question you can answer WITHOUT company-internal knowledge,
   write a client_reply. Otherwise set client_reply to null.
6. Set confidence: "high" | "low" — high only if you are certain of the client reply

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "type": "question|complaint|update|request|general",
  "urgency": "high|medium|low",
  "confidence": "high|low",
  "assigned_admin": "AdminName",
  "assigned_phone": "phone@c.us",
  "comms_alert": "brief alert for internal team",
  "client_reply": "reply text or null"
}`;

  let analysis;
  try {
    const raw = await askClaude(
      [{ role: "user", content: analysisPrompt }],
      "You are a business assistant. Respond ONLY with valid JSON."
    );
    analysis = JSON.parse(raw.replace(/```json|```/g, "").trim());
    console.log("🧠 Analysis:", JSON.stringify(analysis, null, 2));
  } catch (err) {
    console.error("❌ Claude analysis failed:", err.message);
    await sendWhatsAppMessage(COMMS_GROUP,
      `📨 *${clientGroupName}*\n👤 ${senderName}: ${message}\n⚠️ Needs attention`);
    return;
  }

  // ── Send alert to comms group ────────────────────────────
  const urgencyEmoji = analysis.urgency === "high" ? "🔴" : analysis.urgency === "medium" ? "🟡" : "🟢";
  await sendWhatsAppMessage(COMMS_GROUP,
    `${urgencyEmoji} *[${clientGroupName}]* ${(analysis.type || "").toUpperCase()}\n` +
    `👤 From: ${senderName}\n` +
    `💬 "${message.substring(0, 120)}${message.length > 120 ? "..." : ""}"\n\n` +
    `📌 ${analysis.comms_alert}\n` +
    `👉 Assigned: ${analysis.assigned_admin || "Team"}`
  );

  // ── Auto-reply to client only when gating passes ─────────
  if (shouldAutoReply(analysis, message)) {
    await sendWhatsAppMessage(chatId, analysis.client_reply, msgId); // quotes the client's msg
    addToHistory(chatId, "assistant", `[Bot auto-reply]: ${analysis.client_reply}`);
    console.log("💬 Auto-replied to client (quoted)");
  } else {
    console.log(`⏸  Auto-reply suppressed (urgency: ${analysis.urgency}, type: ${analysis.type}, confidence: ${analysis.confidence})`);
  }

  // ── Auto-summary on heavy traffic ────────────────────────
  if (isHeavyTraffic) {
    const coolKey = chatId + "_summary";
    if (Date.now() - (summaryCooldown[coolKey] || 0) > SUMMARY_COOLDOWN) {
      summaryCooldown[coolKey] = Date.now();
      console.log("📊 Heavy traffic — generating auto-summary");
      await generateAndPostSummary(chatId, clientGroupName, "High activity detected");
    }
  }
}

// ────────────────────────────────────────────────────────────
//  SUMMARY GENERATOR (shared by traffic trigger + scheduler)
// ────────────────────────────────────────────────────────────
async function generateAndPostSummary(chatId, groupName, trigger) {
  const recentMsgs = (chatHistory[chatId] || [])
    .slice(-15)
    .map(m => m.content)
    .join("\n");

  if (!recentMsgs.trim()) {
    console.log(`ℹ️  No history to summarise for ${groupName}`);
    return;
  }

  try {
    const summary = await askClaude(
      [{ role: "user", content:
        `Summarise this WhatsApp client conversation from "${groupName}" in 4-5 bullet points.\n` +
        `Include: main topics, open questions, action items, any urgency.\n` +
        `Be concise and business-focused.\n\n${recentMsgs}`
      }],
      "You summarise business WhatsApp conversations concisely.",
      600
    );
    await sendWhatsAppMessage(COMMS_GROUP,
      `📊 *SUMMARY: ${groupName}*\n_(${trigger})_\n\n${summary}`
    );
  } catch (err) {
    console.error("❌ Summary failed:", err.message);
  }
}

// ────────────────────────────────────────────────────────────
//  SCHEDULED DAILY SUMMARIES  (runs 9:00 AM IST every day)
// ────────────────────────────────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  console.log("\n⏰ Scheduled daily summary — running...");
  for (const [chatId, groupName] of Object.entries(CLIENT_GROUPS)) {
    await generateAndPostSummary(chatId, groupName, "Daily 9 AM scheduled summary");
  }
}, { timezone: "Asia/Kolkata" });

// ── Also available on demand via /summary endpoint ───────────
// (see GET /summary below)

// ────────────────────────────────────────────────────────────
//  CORE: Handle internal comms group message
// ────────────────────────────────────────────────────────────
async function handleCommsMessage(chatId, senderName, message) {
  addToHistory(chatId, "user", `[${senderName}]: ${message}`);
  console.log(`\n💼 COMMS GROUP | ${senderName}: ${message}`);

  const CASUAL = ["okay","ok","sure","noted","thanks","👍","👌","done","yes","no","hmm","k","got it","fine","🙏","ack"];
  if (message.length < 6 || CASUAL.includes(message.toLowerCase().trim())) {
    console.log("⏭️  Casual reply — ignored");
    return;
  }

  // ── Built-in commands ─────────────────────────────────────
  if (message.startsWith("/status")) {
    await sendWhatsAppMessage(chatId,
      `📊 *StepOne Bot Status*\n` +
      `✅ Running\n` +
      `👂 Monitoring: ${Object.values(CLIENT_GROUPS).join(", ")}\n` +
      `📨 Comms group: active\n` +
      `🕐 ${nowIST()}\n` +
      `📂 Attachments saved: ${fs.readdirSync(ATTACHMENTS_DIR).length} files`
    );
    return;
  }

  if (message.startsWith("/summary")) {
    for (const [chatId2, groupName] of Object.entries(CLIENT_GROUPS)) {
      await generateAndPostSummary(chatId2, groupName, "Manual /summary request");
    }
    return;
  }

  if (message.startsWith("/help")) {
    await sendWhatsAppMessage(chatId,
      `🤖 *StepOne Assistant v5*\n\n` +
      `Talk to me naturally:\n` +
      `→ "tell her we'll get back in 2 days"\n` +
      `→ "reply to client — meeting is tomorrow 3 PM"\n` +
      `→ "what did the client send in the file?"\n` +
      `→ "summarise the last conversation"\n\n` +
      `/status   — bot health\n` +
      `/summary  — manual summary of all groups\n` +
      `/help     — this message`
    );
    return;
  }

  // ── Build client context for Claude ──────────────────────
  // Include MORE history (last 20) so "who asked about X" queries work
  const clientContext = Object.entries(CLIENT_GROUPS).map(([gid, gname]) => {
    const msgs = (chatHistory[gid] || []).slice(-20).map(m => m.content).join("\n");
    return msgs ? `--- ${gname} (${gid}) ---\n${msgs}` : `--- ${gname}: no recent messages ---`;
  }).join("\n\n");

  const systemPrompt =
`You are ${BOT_NAME}, the AI assistant embedded in StepOne's internal WhatsApp comms group.

Your role:
- Team members talk to you naturally — no commands needed
- "tell her X" / "reply to client saying Y" → compose and SEND that message to the correct client group
- "who asked about X?" / "what did the client ask?" → search through ALL client history below and answer specifically
- "summarise" → summarise the relevant conversation from client history
- "what was in the file?" → check file analysis entries (tagged [FILE:...]) in the history
- Be brief and direct — one short paragraph max unless a summary is asked for
- NEVER auto-reply to clients unless the team explicitly instructs you to

Full client group history (search this to answer any question about what clients said):
${clientContext}

Available client groups:
${Object.entries(CLIENT_GROUPS).map(([id, name]) => `- ${name} (${id})`).join("\n")}

To send a message to a client group, include this marker ONCE at the END of your reply:
SEND_TO_CLIENT:[group_id]:[full message to send]

The message after the second colon can be multiple lines — write it exactly as it should appear to the client.

Example (single line):
SEND_TO_CLIENT:120363410603753005@g.us:Thank you for your patience, we'll get back to you within 2 business days.

Example (multi-line answer):
SEND_TO_CLIENT:120363410603753005@g.us:Hi! Here are the answers to your questions:

1. *Tech Stack*: React.js frontend, Node.js + Express backend
2. *Database*: MySQL
3. *Authentication*: JWT — fully supported
4. *Seat Selection*: Can be added as a future enhancement

Let us know if you have more questions!`;

  const reply = await askClaude(chatHistory[chatId].slice(-10), systemPrompt);

  // ── Parse SEND_TO_CLIENT — handles multi-line messages ───
  // Format: SEND_TO_CLIENT:[group_id]:[message...]
  // The message can span multiple lines — don't use a simple regex
  function parseSendToClient(text) {
    const marker = "SEND_TO_CLIENT:";
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const after = text.substring(idx + marker.length);
    const colonIdx = after.indexOf(":");
    if (colonIdx === -1) return null;
    const groupId = after.substring(0, colonIdx).trim();
    // Message is everything after [groupId]: — strip any trailing SEND_TO_CLIENT markers
    const rawMsg = after.substring(colonIdx + 1).replace(/\nSEND_TO_CLIENT:.*/gs, "").trim();
    return { groupId, message: rawMsg };
  }

  const parsed = parseSendToClient(reply);
  if (parsed) {
    const { groupId: targetGroupId, message: clientMessage } = parsed;
    const cleanReply = reply
      .substring(0, reply.indexOf("SEND_TO_CLIENT:"))
      .trim();

    if (CLIENT_GROUPS[targetGroupId]) {
      // Quote the last message from the client group if available
      const quoteId = lastMsgId[targetGroupId] || null;
      await sendWhatsAppMessage(targetGroupId, clientMessage, quoteId);
      addToHistory(targetGroupId, "assistant", `[Bot sent on team instruction]: ${clientMessage}`);
      console.log("📤 Sent to client on team instruction");
      const confirmMsg = cleanReply || `✅ Sent to *${CLIENT_GROUPS[targetGroupId]}*:\n"${clientMessage.substring(0, 120)}${clientMessage.length > 120 ? "..." : ""}"`;
      await sendWhatsAppMessage(chatId, confirmMsg);
    } else {
      await sendWhatsAppMessage(chatId, `⚠️ Unknown group: ${targetGroupId}\n\n${cleanReply}`);
    }
  } else {
    addToHistory(chatId, "assistant", reply);
    await sendWhatsAppMessage(chatId, reply);
  }
}

// ────────────────────────────────────────────────────────────
//  CORE: Direct message to bot
// ────────────────────────────────────────────────────────────
async function handleDirectMessage(chatId, senderName, message) {
  addToHistory(chatId, "user", `[${senderName}]: ${message}`);

  // Build full client context — same as comms handler
  const clientContext = Object.entries(CLIENT_GROUPS).map(([gid, gname]) => {
    const msgs = (chatHistory[gid] || []).slice(-20).map(m => m.content).join("\n");
    return msgs ? `--- ${gname} ---\n${msgs}` : `--- ${gname}: no recent messages ---`;
  }).join("\n\n");

  const reply = await askClaude(
    chatHistory[chatId].slice(-10),
    `You are ${BOT_NAME}, personal assistant for the StepOne team.
You have full access to all client group conversations.

Client group history:
${clientContext}

Answer questions about clients, summarise conversations, list open items.
Be concise and direct. No need to ask for the conversation — you already have it above.`
  );

  addToHistory(chatId, "assistant", reply);
  await sendWhatsAppMessage(chatId, reply);
}

// ────────────────────────────────────────────────────────────
//  HISTORY BOOTSTRAP — Tries multiple endpoint formats
// ────────────────────────────────────────────────────────────
async function fetchRecentMessages(chatId, chatName) {
  // Try endpoint variants in order — one of these should work
  const candidates = [
    `https://api.periskope.app/v1/chats/${encodeURIComponent(chatId)}/messages?limit=30`,
    `https://api.periskope.app/v2/chats/${encodeURIComponent(chatId)}/messages?limit=30`,
    `https://api.periskope.app/v1/messages?chat_id=${encodeURIComponent(chatId)}&limit=30`,
    `https://api.periskope.app/v1/messages/list?chat_id=${encodeURIComponent(chatId)}&limit=30`,
  ];

  for (const url of candidates) {
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${PERISKOPE_KEY}`, "x-phone": BOT_PHONE },
        timeout: 8000,
      });

      const msgs = res.data?.messages || res.data?.data || res.data?.items || [];
      if (!Array.isArray(msgs) || msgs.length === 0) {
        console.log(`ℹ️  ${chatName}: endpoint OK but no messages (${url})`);
        return;
      }

      if (!chatHistory[chatId]) chatHistory[chatId] = [];
      let loaded = 0;
      for (const m of msgs.reverse()) {
        if (!m.body && !m.text) continue;
        const body   = m.body || m.text || "";
        const sender = m.from_me ? "StepOne Bot" : (m.sender_name || m.sender_phone || "Client");
        const role   = m.from_me ? "assistant" : "user";
        // Periskope sends unix seconds; JS Date needs ms — handle both
        let rawTs = m.timestamp || m.created_at || m.created || null;
        if (rawTs && rawTs < 1e10) rawTs = rawTs * 1000; // seconds → ms
        const tsDate = rawTs ? new Date(rawTs) : null;
        const ts = tsDate && !isNaN(tsDate)
          ? tsDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
          : nowIST();
        const entry = { role, content: `[${ts}] [${sender}]: ${body}` };
        if (!chatHistory[chatId].find(h => h.content === entry.content)) {
          chatHistory[chatId].push(entry);
          loaded++;
        }
      }
      if (chatHistory[chatId].length > MAX_HISTORY)
        chatHistory[chatId] = chatHistory[chatId].slice(-MAX_HISTORY);
      if (loaded > 0) { saveHistory(); console.log(`✅ Loaded ${loaded} msgs from ${chatName}`); }
      return; // success — stop trying
    } catch (e) {
      const reason = e.response?.data?.message || e.response?.data?.error || e.message;
      console.log(`⚠️  ${chatName} [${url.split("/v")[1]?.split("?")[0]}]: ${reason}`);
    }
  }
  console.warn(`❌ Could not fetch history for ${chatName} — all endpoints failed`);
}

async function bootstrapHistory() {
  console.log("\n🔄 Fetching message history...");
  const all = { ...CLIENT_GROUPS, [COMMS_GROUP]: "s1_communication_test" };
  for (const [chatId, name] of Object.entries(all)) {
    await fetchRecentMessages(chatId, name);
  }
  console.log("✅ Bootstrap complete\n");
}

// ── Last 10 raw webhook payloads — inspect at /debug-webhooks ─
const recentWebhooks = [];

// ────────────────────────────────────────────────────────────
//  WEBHOOK
// ────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const payload   = req.body;
    const eventType = payload.event_type || "";

    // ── Always store raw payload for debugging ───────────────
    recentWebhooks.unshift({ time: nowIST(), eventType, raw: payload });
    if (recentWebhooks.length > 10) recentWebhooks.pop();

    if (eventType !== "message.created") {
      console.log(`⏭️  Skipped: ${eventType}`);
      return;
    }

    const data        = payload.data || payload;
    const message     = data.body || data.message || data.text || data.content || null;
    const chatId      = data.chat_id || null;
    const senderPhone = data.sender_phone || data.from || null;
    const senderName  = data.sender_name || data.pushname || data.contact_name || senderPhone;
    const isFromBot   = data.from_me === true || senderPhone === BOT_PHONE;

    // ── Dedup ────────────────────────────────────────────────
    const msgId = data.id || data.message_id || null;
    const dedupKey = msgId ||
      `${chatId}:${senderPhone}:${(message || "").substring(0, 50)}:${Math.floor(Date.now() / 30000)}`;
    if (processedMsgIds.has(dedupKey)) {
      console.log(`⏭️  Duplicate — skipped`);
      return;
    }
    processedMsgIds.add(dedupKey);
    if (processedMsgIds.size > 500) processedMsgIds.delete(processedMsgIds.values().next().value);
    if (chatId && msgId) lastMsgId[chatId] = msgId;

    if (isFromBot) { console.log("⏭️  From bot — skipped"); return; }
    if (!chatId)   { console.log("⏭️  No chatId"); return; }

    // ── Resolve attachment URL across ALL known Periskope field names ──
    const attachmentUrl =
      data.media_url          ||
      data.attachment_url     ||
      data.url                ||
      data.document?.url      ||
      data.document?.link     ||
      data.media?.url         ||
      data.file?.url          ||
      data.image?.url         ||
      null;

    const attachFilename =
      data.filename           ||
      data.media_filename     ||
      data.attachment_name    ||
      data.document?.filename ||
      data.document?.caption  ||
      data.media?.filename    ||
      data.file?.name         ||
      null;

    const attachMime =
      data.mime_type          ||
      data.mimetype           ||
      data.media_mime_type    ||
      data.document?.mimetype ||
      data.media?.mimetype    ||
      "";

    const hasAttachment = !!(attachmentUrl || attachFilename ||
      data.document || data.media || data.file);

    // ── Log full payload for file messages so we can see actual fields ──
    if (!message || hasAttachment) {
      console.log(`\n📎 FILE/MEDIA WEBHOOK — dumping full data to see Periskope fields:`);
      console.log(JSON.stringify(data, null, 2));
    }

    if (!message && !hasAttachment) {
      console.log("⏭️  No message or attachment");
      return;
    }

    console.log(`\n📨 ${chatId} | ${senderName}: ${(message || `(file: ${attachFilename || "unknown"})`).substring(0, 80)}`);

    // Pass normalised attachment fields downstream
    const normalisedData = {
      ...data,
      media_url:  attachmentUrl,
      filename:   attachFilename || "attachment",
      mime_type:  attachMime,
    };

    if (CLIENT_GROUPS[chatId]) {
      await handleClientMessage(chatId, CLIENT_GROUPS[chatId], senderName, message, normalisedData, msgId);
    } else if (chatId === COMMS_GROUP) {
      await handleCommsMessage(chatId, senderName, message);
    } else {
      await handleDirectMessage(chatId, senderName, message);
    }
  } catch (err) {
    console.error("❌ WEBHOOK CRASHED:", err.message, err.stack);
  }
});

// ────────────────────────────────────────────────────────────
//  UTILITY ROUTES
// ────────────────────────────────────────────────────────────

app.get("/refresh-groups", async (req, res) => {
  const before = Object.keys(CLIENT_GROUPS).length;
  await discoverClientGroups();
  const after = Object.keys(CLIENT_GROUPS).length;
  res.json({
    status: "refreshed",
    groups_before: before,
    groups_after: after,
    client_groups: CLIENT_GROUPS,
  });
});

// Shows last 10 raw webhook payloads — use after sending a PDF to see exact fields
app.get("/debug-webhooks", (req, res) => {
  res.json({ count: recentWebhooks.length, webhooks: recentWebhooks });
});

app.get("/list-chats", async (req, res) => {
  try {
    const response = await axios.get("https://api.periskope.app/v1/chats", {
      headers: { Authorization: `Bearer ${PERISKOPE_KEY}`, "x-phone": BOT_PHONE }
    });
    const chats = response.data?.chats || response.data?.data || response.data || [];
    res.json({
      groups: chats.filter(c => c.chat_id?.endsWith("@g.us")).map(c => ({ name: c.chat_name, id: c.chat_id })),
      direct: chats.filter(c => !c.chat_id?.endsWith("@g.us")).map(c => ({ name: c.chat_name, id: c.chat_id })),
    });
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

app.get("/summary", async (req, res) => {
  const results = [];
  for (const [chatId, groupName] of Object.entries(CLIENT_GROUPS)) {
    await generateAndPostSummary(chatId, groupName, "Manual API trigger");
    results.push(groupName);
  }
  res.json({ status: "summaries posted", groups: results });
});

app.get("/test-send", async (req, res) => {
  const chatId = req.query.chatId || "917731066049@c.us";
  await sendWhatsAppMessage(chatId, "✅ StepOne Bot v5 test — working!");
  res.json({ status: "sent", to: chatId });
});

app.get("/attachments", (req, res) => {
  const files = fs.readdirSync(ATTACHMENTS_DIR).map(f => {
    const stat = fs.statSync(path.join(ATTACHMENTS_DIR, f));
    return { file: f, size: `${(stat.size / 1024).toFixed(1)} KB`, saved: stat.mtime };
  });
  res.json({ count: files.length, files });
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ StepOne Bot v5 RUNNING",
    time: nowIST(),
    comms_group: "s1_communication_test",
    monitoring: CLIENT_GROUPS,           // shows id → name map
    admins: Object.keys(ADMINS),
    scheduled_summary: "Daily 9:00 AM IST",
    attachments_saved: fs.readdirSync(ATTACHMENTS_DIR).length,
    traffic: Object.fromEntries(
      Object.entries(trafficTracker).map(([k, v]) => [k, v.length])
    ),
  });
});

// ────────────────────────────────────────────────────────────
//  START
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   StepOne Smart Bot v5 — RUNNING             ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n🚀 Health       : http://localhost:${PORT}/`);
  console.log(`📡 Webhook      : http://192.168.0.115:${PORT}/webhook`);
  console.log(`📋 List chats   : http://localhost:${PORT}/list-chats`);
  console.log(`📊 Manual summary: http://localhost:${PORT}/summary`);
  console.log(`📎 Attachments  : http://localhost:${PORT}/attachments`);
  console.log(`\n📣 Comms group  : s1_communication_test`);
  console.log(`👥 Admins       : ${Object.keys(ADMINS).join(", ")}`);
  console.log(`⏰ Daily summary : 9:00 AM IST`);
  console.log(`🔍 Client groups : auto-discovering from Periskope...`);
  console.log(`\n✅ Waiting for messages...\n`);
  // Discover groups first, then load history for those groups
  discoverClientGroups().then(() => bootstrapHistory());
});