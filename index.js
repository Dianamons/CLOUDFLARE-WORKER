// index.js — Bot Telegram Cloudflare Workers & KV
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ENV: TELEGRAM_BOT_TOKEN
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN harus diisi.');

const bot = new TelegramBot(TOKEN, { polling: true });

// Session per user (RAM, non-persistent)
const session = {};

// --- Helper menu
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [ { text: '🚀 Deploy Worker', callback_data: 'deploy_worker' } ],
        [ { text: '📜 Daftar Worker', callback_data: 'list_workers' } ],
        [ { text: '➕ Buat KV Namespace', callback_data: 'create_kv' } ],
        [ { text: '🗂️ Daftar KV Namespace', callback_data: 'list_kv' } ],
        [ { text: '🔗 Binding KV ke Worker', callback_data: 'bind_kv' } ],
        [ { text: '❌ Hapus Worker', callback_data: 'delete_worker' } ],
        [ { text: '❌ Hapus KV Namespace', callback_data: 'delete_kv' } ],
        [ { text: '🔒 Logout', callback_data: 'logout' } ],
      ]
    }
  }
}

// --- START flow
bot.onText(/\/start/, (msg) => {
  session[msg.from.id] = { stage: 'await_account_id' };
  bot.sendMessage(msg.chat.id, 'Selamat datang di Bot Cloudflare!\n\nMasukkan *Account ID* Cloudflare kamu:', { parse_mode: 'Markdown' });
});

// --- Handle login stages
bot.on('message', async (msg) => {
  // Ignore callback query and commands
  if (msg.text && msg.text.startsWith('/')) return;
  if (!session[msg.from.id] || !session[msg.from.id].stage) return;

  const user = session[msg.from.id];

  // Stage: input Account ID
  if (user.stage === 'await_account_id') {
    user.account_id = msg.text.trim();
    user.stage = 'await_api_token';
    return bot.sendMessage(msg.chat.id, 'Masukkan *API Token* Cloudflare kamu:', { parse_mode: 'Markdown' });
  }

  // Stage: input API Token
  if (user.stage === 'await_api_token') {
    user.api_token = msg.text.trim();
    // Cek validasi ke Cloudflare
    try {
      const resp = await axios.get(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts`,
        { headers: { Authorization: `Bearer ${user.api_token}` } }
      );
      if (resp.data && resp.data.success) {
        user.stage = 'logged_in';
        bot.sendMessage(msg.chat.id, '✅ *Login Cloudflare berhasil!*\n\nSilakan pilih menu:', { parse_mode: 'Markdown', ...mainMenu() });
      } else {
        user.stage = 'await_account_id';
        bot.sendMessage(msg.chat.id, '❌ Login gagal. Pastikan Account ID & API Token benar!\n\nMasukkan Account ID lagi:', { parse_mode: 'Markdown' });
      }
    } catch {
      user.stage = 'await_account_id';
      bot.sendMessage(msg.chat.id, '❌ Login gagal. Pastikan Account ID & API Token benar!\n\nMasukkan Account ID lagi:', { parse_mode: 'Markdown' });
    }
  }
});

// --- Menu utama (inline keyboard)
bot.on('callback_query', async (query) => {
  const id = query.from.id;
  const user = session[id];
  if (!user || user.stage !== 'logged_in') {
    bot.answerCallbackQuery(query.id, { text: 'Silakan login dulu.' });
    return;
  }
  const chatId = query.message.chat.id;

  switch (query.data) {
    case 'deploy_worker':
      user.stage = 'await_worker_name';
      bot.sendMessage(chatId, 'Masukkan *nama Worker* yang ingin dibuat:', { parse_mode: 'Markdown' });
      break;

    case 'list_workers':
      bot.sendMessage(chatId, 'Memuat daftar Worker...');
      try {
        const resp = await axios.get(
          `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts`,
          { headers: { Authorization: `Bearer ${user.api_token}` } }
        );
        if (resp.data && resp.data.result && resp.data.result.length) {
          const list = resp.data.result.map(w => `• ${w.id}`).join('\n');
          bot.sendMessage(chatId, `Daftar Worker:\n${list}`);
        } else {
          bot.sendMessage(chatId, 'Belum ada Worker.');
        }
      } catch {
        bot.sendMessage(chatId, 'Gagal mengambil daftar Worker.');
      }
      break;

    case 'create_kv':
      user.stage = 'await_kv_name';
      bot.sendMessage(chatId, 'Masukkan *nama KV Namespace* yang ingin dibuat:', { parse_mode: 'Markdown' });
      break;

    case 'list_kv':
      bot.sendMessage(chatId, 'Memuat daftar KV Namespace...');
      try {
        const resp = await axios.get(
          `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/storage/kv/namespaces`,
          { headers: { Authorization: `Bearer ${user.api_token}` } }
        );
        if (resp.data && resp.data.result && resp.data.result.length) {
          const list = resp.data.result.map(kv => `• ${kv.title} (${kv.id})`).join('\n');
          bot.sendMessage(chatId, `Daftar KV Namespace:\n${list}`);
        } else {
          bot.sendMessage(chatId, 'Belum ada KV Namespace.');
        }
      } catch {
        bot.sendMessage(chatId, 'Gagal mengambil daftar KV Namespace.');
      }
      break;

    case 'bind_kv':
      bot.sendMessage(chatId, 'Fitur binding KV ke Worker belum diimplementasikan.\n(Siap dikembangkan lanjut)');
      break;

    case 'delete_worker':
      user.stage = 'await_delete_worker';
      bot.sendMessage(chatId, 'Masukkan *nama Worker* yang ingin dihapus:', { parse_mode: 'Markdown' });
      break;

    case 'delete_kv':
      user.stage = 'await_delete_kv';
      bot.sendMessage(chatId, 'Masukkan *ID KV Namespace* yang ingin dihapus:', { parse_mode: 'Markdown' });
      break;

    case 'logout':
      delete session[id];
      bot.sendMessage(chatId, 'Anda telah logout.\nKetik /start untuk login lagi.');
      break;
  }

  bot.answerCallbackQuery(query.id);
});

// --- Handler fitur input lanjutan (worker name / KV name / hapus dll)
bot.on('message', async (msg) => {
  if (!session[msg.from.id] || !session[msg.from.id].stage) return;
  const user = session[msg.from.id];

  // Deploy Worker: input nama → input file JS
  if (user.stage === 'await_worker_name') {
    user.worker_name = msg.text.trim();
    user.stage = 'await_worker_file';
    return bot.sendMessage(msg.chat.id, `Kirim *file kode JS* untuk Worker "${user.worker_name}":`, { parse_mode: 'Markdown' });
  }

  // Deploy Worker: upload file JS
  if (user.stage === 'await_worker_file' && msg.document) {
    const fileId = msg.document.file_id;
    const fileUrl = await bot.getFileLink(fileId);
    // Ambil file kode JS
    try {
      const code = (await axios.get(fileUrl)).data;
      // Deploy ke Cloudflare
      const deployResp = await axios.put(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts/${user.worker_name}`,
        code,
        {
          headers: {
            Authorization: `Bearer ${user.api_token}`,
            'Content-Type': 'application/javascript'
          }
        }
      );
      if (deployResp.data && deployResp.data.success) {
        bot.sendMessage(msg.chat.id, `✅ Worker "${user.worker_name}" berhasil di-deploy!\n\nhttps://${user.worker_name}.${user.account_id}.workers.dev`, mainMenu());
      } else {
        bot.sendMessage(msg.chat.id, `❌ Deploy Worker gagal. ${deployResp.data.errors ? JSON.stringify(deployResp.data.errors) : ''}`, mainMenu());
      }
    } catch (e) {
      bot.sendMessage(msg.chat.id, '❌ Gagal upload/deploy Worker. Pastikan file JS valid.', mainMenu());
    }
    user.stage = 'logged_in';
    delete user.worker_name;
    return;
  }

  // Buat KV Namespace
  if (user.stage === 'await_kv_name') {
    const kvName = msg.text.trim();
    bot.sendMessage(msg.chat.id, 'Membuat KV Namespace...');
    try {
      const resp = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/storage/kv/namespaces`,
        { title: kvName },
        { headers: { Authorization: `Bearer ${user.api_token}` } }
      );
      if (resp.data && resp.data.success) {
        bot.sendMessage(msg.chat.id, `✅ KV Namespace "${kvName}" berhasil dibuat!`, mainMenu());
      } else {
        bot.sendMessage(msg.chat.id, `❌ Gagal membuat KV Namespace. ${resp.data.errors ? JSON.stringify(resp.data.errors) : ''}`, mainMenu());
      }
    } catch {
      bot.sendMessage(msg.chat.id, '❌ Gagal membuat KV Namespace.', mainMenu());
    }
    user.stage = 'logged_in';
    return;
  }

  // Hapus Worker
  if (user.stage === 'await_delete_worker') {
    const workerName = msg.text.trim();
    bot.sendMessage(msg.chat.id, `Menghapus Worker "${workerName}"...`);
    try {
      const resp = await axios.delete(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts/${workerName}`,
        { headers: { Authorization: `Bearer ${user.api_token}` } }
      );
      if (resp.data && resp.data.success) {
        bot.sendMessage(msg.chat.id, `✅ Worker "${workerName}" berhasil dihapus!`, mainMenu());
      } else {
        bot.sendMessage(msg.chat.id, `❌ Gagal menghapus Worker. ${resp.data.errors ? JSON.stringify(resp.data.errors) : ''}`, mainMenu());
      }
    } catch {
      bot.sendMessage(msg.chat.id, '❌ Gagal menghapus Worker.', mainMenu());
    }
    user.stage = 'logged_in';
    return;
  }

  // Hapus KV Namespace
  if (user.stage === 'await_delete_kv') {
    const kvId = msg.text.trim();
    bot.sendMessage(msg.chat.id, `Menghapus KV Namespace "${kvId}"...`);
    try {
      const resp = await axios.delete(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/storage/kv/namespaces/${kvId}`,
        { headers: { Authorization: `Bearer ${user.api_token}` } }
      );
      if (resp.data && resp.data.success) {
        bot.sendMessage(msg.chat.id, `✅ KV Namespace "${kvId}" berhasil dihapus!`, mainMenu());
      } else {
        bot.sendMessage(msg.chat.id, `❌ Gagal menghapus KV Namespace. ${resp.data.errors ? JSON.stringify(resp.data.errors) : ''}`, mainMenu());
      }
    } catch {
      bot.sendMessage(msg.chat.id, '❌ Gagal menghapus KV Namespace.', mainMenu());
    }
    user.stage = 'logged_in';
    return;
  }
});

// --- End of main logic
console.log('Bot Cloudflare Telegram siap dijalankan!');
