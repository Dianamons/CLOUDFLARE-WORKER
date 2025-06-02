const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "ISI_TOKEN_BOT";
const ADMIN_ID = process.env.ADMIN_ID || "ISI_ADMIN_ID"; // Ganti dengan ID Telegram Admin

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json());

/**
 * Struktur session sederhana (in-memory, bisa diganti ke database)
 * {
 *   [userId]: {
 *     approved: boolean,
 *     name: string,
 *     cloudflare: {
 *       apiToken: string,
 *       accountId: string
 *     },
 *     history: [],
 *   }
 * }
 */
const sessions = {};

function isApproved(userId) {
  return sessions[userId] && sessions[userId].approved;
}
function hasCloudflareInfo(userId) {
  return sessions[userId]?.cloudflare?.apiToken && sessions[userId]?.cloudflare?.accountId;
}
function logHistory(userId, action, details = "") {
  if (!sessions[userId].history) sessions[userId].history = [];
  sessions[userId].history.push({
    time: new Date().toISOString(),
    action,
    details
  });
}

// Webhook endpoint
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// -- MENU UTAMA
const menuKeyboard = {
  inline_keyboard: [
    [
      { text: "🚀 Deploy Worker", callback_data: "deploy_worker" },
      { text: "📦 List Worker", callback_data: "list_worker" }
    ],
    [
      { text: "✏️ Edit Worker", callback_data: "edit_worker" },
      { text: "♻️ Restart Worker", callback_data: "restart_worker" }
    ],
    [
      { text: "🗑️ Hapus Worker", callback_data: "delete_worker" },
      { text: "🕑 Histori User", callback_data: "user_history" }
    ],
    [
      { text: "📚 Panduan", callback_data: "help" }
    ]
  ]
};

// -- TELEGRAM LOGIC
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  if (!sessions[userId]) sessions[userId] = { approved: false, history: [] };
  if (!sessions[userId].approved) {
    bot.sendMessage(userId, "Selamat datang di *Cloudflare Worker Manager!*\n\nSilakan daftar dulu untuk akses fitur bot.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📝 Daftar", callback_data: "register_start" }]] }
    });
  } else if (!hasCloudflareInfo(userId)) {
    bot.sendMessage(userId, "🛡️ *Lengkapi data Cloudflare*\n\nSebelum menggunakan bot, silakan input data Cloudflare kamu.\nKetik /cloudflare untuk mulai.");
  } else {
    bot.sendMessage(userId, "🔧 *Cloudflare Worker Manager*\n\nSilakan pilih fitur:", {
      parse_mode: "Markdown",
      reply_markup: menuKeyboard
    });
  }
});

bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const session = sessions[userId] || {};

  if (query.data === "register_start") {
    session.step = "input_name";
    sessions[userId] = session;
    bot.sendMessage(chatId, "Silakan masukkan nama lengkap Anda:");
    return;
  }
  // Admin approve
  if (query.data && query.data.startsWith("approve_user:")) {
    const [_, approveId] = query.data.split(":");
    if (!sessions[approveId]) sessions[approveId] = {};
    sessions[approveId].approved = true;
    sessions[approveId].step = null;
    sessions[approveId].history = [];
    bot.sendMessage(approveId, "✅ Pendaftaran kamu sudah disetujui admin!\nSilakan lengkapi data Cloudflare dengan /cloudflare.");
    bot.sendMessage(ADMIN_ID, `User (ID: ${approveId}) sudah kamu setujui.`);
    return;
  }

  // Menu utama
  if (isApproved(userId) && hasCloudflareInfo(userId)) {
    if (query.data === "deploy_worker") {
      session.step = "input_worker_name";
      bot.sendMessage(chatId, "Masukkan nama Worker yang ingin kamu deploy:");
    }
    if (query.data === "list_worker") {
      await handleListWorker(chatId, userId);
    }
    if (query.data === "edit_worker") {
      await handleSelectWorker(chatId, userId, "edit");
    }
    if (query.data.startsWith("edit_worker:")) {
      session.editWorkerName = query.data.split(":")[1];
      session.step = "edit_worker_code";
      bot.sendMessage(chatId, `Kirim kode baru untuk Worker *${session.editWorkerName}* (JavaScript):`, { parse_mode: "Markdown" });
    }
    if (query.data === "restart_worker") {
      await handleSelectWorker(chatId, userId, "restart");
    }
    if (query.data.startsWith("restart_worker:")) {
      const workerName = query.data.split(":")[1];
      await restartWorker(chatId, userId, workerName);
    }
    if (query.data === "delete_worker") {
      await handleSelectWorker(chatId, userId, "delete");
    }
    if (query.data.startsWith("delete_worker:")) {
      const workerName = query.data.split(":")[1];
      await deleteWorker(chatId, userId, workerName);
    }
    if (query.data === "user_history") {
      const hist = session.history || [];
      if (!hist.length) return bot.sendMessage(chatId, "Belum ada histori aktivitas.");
      let msg = "🕑 *Histori aktivitas kamu:*\n\n";
      hist.slice(-20).reverse().forEach((h, i) => {
        msg += `${i + 1}. [${new Date(h.time).toLocaleString()}] ${h.action} ${h.details ? `(${h.details})` : ""}\n`;
      });
      bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }
    if (query.data === "help") {
      bot.sendMessage(chatId, "📚 *Panduan*\n\n- Daftar & tunggu approve admin\n- Input data Cloudflare (/cloudflare)\n- Deploy Worker: input nama, lalu kode\n- List Worker: lihat daftar Worker kamu\n- Edit Worker: pilih worker, lalu kirim kode baru\n- Restart Worker: pilih worker untuk restart\n- Hapus Worker: pilih worker untuk hapus\n- Histori User: lihat seluruh aktivitas kamu\n\nHubungi admin jika butuh bantuan lebih lanjut.", { parse_mode: "Markdown" });
    }
  }
});

// Pesan user
bot.on("message", async (msg) => {
  if (!msg.from) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!sessions[userId]) sessions[userId] = { approved: false, history: [] };
  const session = sessions[userId];

  // Daftar - input nama
  if (session.step === "input_name") {
    session.name = msg.text.trim();
    session.step = "waiting_approval";
    bot.sendMessage(ADMIN_ID,
      `🆕 *User Baru Mendaftar*\nNama: ${session.name}\nID: ${userId}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Setujui", callback_data: `approve_user:${userId}` }]
          ]
        }
      }
    );
    bot.sendMessage(chatId, "Pendaftaran kamu sedang menunggu persetujuan admin.");
    return;
  }

  // Data Cloudflare
  if (msg.text && msg.text.startsWith("/cloudflare")) {
    session.step = "input_api_token";
    bot.sendMessage(chatId, "Masukkan *API Token* Cloudflare kamu:", { parse_mode: "Markdown" });
    return;
  }
  if (session.step === "input_api_token") {
    session.cloudflare = session.cloudflare || {};
    session.cloudflare.apiToken = msg.text.trim();
    session.step = "input_account_id";
    bot.sendMessage(chatId, "Masukkan *Account ID* Cloudflare kamu:", { parse_mode: "Markdown" });
    return;
  }
  if (session.step === "input_account_id") {
    session.cloudflare.accountId = msg.text.trim();
    session.step = null;
    bot.sendMessage(chatId, "✅ Data Cloudflare sudah disimpan!\nKamu bisa akses menu utama dengan /start.");
    return;
  }

  // Deploy Worker - input nama Worker
  if (session.step === "input_worker_name" && isApproved(userId) && hasCloudflareInfo(userId)) {
    session.tempWorkerName = msg.text.trim();
    session.step = "input_worker_code";
    bot.sendMessage(chatId, `Nama Worker: *${session.tempWorkerName}*\nSekarang kirim kode Worker (JavaScript):`, { parse_mode: "Markdown" });
    return;
  }
  // Deploy Worker - input kode Worker
  if (session.step === "input_worker_code" && isApproved(userId) && hasCloudflareInfo(userId)) {
    const workerCode = msg.text;
    if (!session.tempWorkerName) {
      bot.sendMessage(chatId, "⚠️ Nama Worker tidak ditemukan. Ulangi proses deploy.");
      session.step = null;
      return;
    }
    try {
      const result = await uploadWorker(session.cloudflare, session.tempWorkerName, workerCode);
      logHistory(userId, "Deploy Worker", session.tempWorkerName);
      bot.sendMessage(chatId, `✅ Worker *${session.tempWorkerName}* berhasil di-deploy!\n\nID: ${result.id || "(lihat di Cloudflare Dashboard)"}`, { parse_mode: "Markdown" });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Gagal deploy Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
    }
    session.tempWorkerName = null;
    session.step = null;
    return;
  }

  // Edit Worker - input kode baru
  if (session.step === "edit_worker_code" && session.editWorkerName && isApproved(userId) && hasCloudflareInfo(userId)) {
    const newCode = msg.text;
    try {
      const result = await uploadWorker(session.cloudflare, session.editWorkerName, newCode);
      logHistory(userId, "Edit Worker", session.editWorkerName);
      bot.sendMessage(chatId, `✏️ Worker *${session.editWorkerName}* berhasil diedit!`, { parse_mode: "Markdown" });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Gagal edit Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
    }
    session.editWorkerName = undefined;
    session.step = null;
    return;
  }
});

// ---- Cloudflare Logic ----
async function uploadWorker(cloudflare, workerName, code) {
  // Docs: https://api.cloudflare.com/#worker-script-upload-worker
  const url = `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/scripts/${workerName}`;
  const headers = {
    Authorization: `Bearer ${cloudflare.apiToken}`,
    "Content-Type": "application/javascript"
  };
  const response = await axios.put(url, code, { headers });
  if (!response.data.success) throw new Error("Cloudflare error: " + JSON.stringify(response.data.errors));
  return response.data.result;
}

async function listWorkers(cloudflare) {
  // Docs: https://api.cloudflare.com/#worker-scripts-list
  const url = `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/scripts`;
  const headers = { Authorization: `Bearer ${cloudflare.apiToken}` };
  const response = await axios.get(url, { headers });
  if (!response.data.success) throw new Error("Cloudflare error: " + JSON.stringify(response.data.errors));
  return response.data.result;
}

async function deleteWorker(cloudflare, workerName) {
  // Docs: https://api.cloudflare.com/#worker-script-delete-worker
  const url = `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/scripts/${workerName}`;
  const headers = { Authorization: `Bearer ${cloudflare.apiToken}` };
  const response = await axios.delete(url, { headers });
  if (!response.data.success) throw new Error("Cloudflare error: " + JSON.stringify(response.data.errors));
  return response.data;
}

// List Worker
async function handleListWorker(chatId, userId) {
  const session = sessions[userId];
  try {
    const workers = await listWorkers(session.cloudflare);
    if (!workers.length) return bot.sendMessage(chatId, "🚫 Belum ada Worker di akun Cloudflare kamu.");
    let msgList = "📦 *Daftar Worker kamu:*\n\n";
    workers.forEach((w, i) => {
      msgList += `${i + 1}. ${w.id} (created: ${w.created_on ? new Date(w.created_on).toLocaleString() : "?"})\n`;
    });
    bot.sendMessage(chatId, msgList, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal mengambil daftar Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
  }
}

// Pilih Worker dari daftar untuk edit/delete/restart
async function handleSelectWorker(chatId, userId, action) {
  const session = sessions[userId];
  try {
    const workers = await listWorkers(session.cloudflare);
    if (!workers.length) return bot.sendMessage(chatId, `Tidak ada Worker untuk ${action}.`);
    let opts = {
      reply_markup: {
        inline_keyboard: workers.map((w) => [
          { text: `${w.id}`, callback_data: `${action}_worker:${w.id}` }
        ])
      }
    };
    bot.sendMessage(chatId, `Pilih Worker yang ingin di-${action}:`, opts);
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal mengambil daftar Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
  }
}

// Delete Worker
async function deleteWorkerHandler(cloudflare, workerName) {
  return await deleteWorker(cloudflare, workerName);
}
async function deleteWorker(chatId, userId, workerName) {
  const session = sessions[userId];
  try {
    await deleteWorkerHandler(session.cloudflare, workerName);
    logHistory(userId, "Hapus Worker", workerName);
    bot.sendMessage(chatId, `🗑️ Worker *${workerName}* berhasil dihapus.`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal hapus Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
  }
}

// Restart Worker (Cloudflare tidak punya restart, kita simulasikan edit ulang)
async function restartWorker(chatId, userId, workerName) {
  const session = sessions[userId];
  try {
    // Ambil kode worker
    const url = `https://api.cloudflare.com/client/v4/accounts/${session.cloudflare.accountId}/workers/scripts/${workerName}`;
    const headers = { Authorization: `Bearer ${session.cloudflare.apiToken}` };
    const resp = await axios.get(url, { headers });
    const code = resp.data.result?.content || `// Kosong`;
    // Upload ulang
    await uploadWorker(session.cloudflare, workerName, code);
    logHistory(userId, "Restart Worker", workerName);
    bot.sendMessage(chatId, `♻️ Worker *${workerName}* berhasil di-restart!`, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal restart Worker: ${e.response?.data?.errors?.[0]?.message || e.message}`);
  }
}

// Express Run
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot is running on port " + PORT);
  console.log(`Set webhook ke: https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://<YOUR_RAILWAY_URL>/bot${TELEGRAM_BOT_TOKEN}`);
});
