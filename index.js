const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// === SET ADMIN TELEGRAM ID DI SINI
const ADMIN_TELEGRAM_ID = "7857630943";

// ENV: TELEGRAM_BOT_TOKEN
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN harus diisi.');

const bot = new TelegramBot(TOKEN, { polling: true });

// --- Session per user (RAM, non-persistent)
const session = {};

const USERS_FILE = path.join(__dirname, 'users.json');

// --- Helper: load & save user database
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- Helper: waktu ISO ke string lokal
function formatDate(dt) {
  return new Date(dt).toISOString().replace('T', ' ').slice(0, 19) + " UTC";
}

// --- Helper menu utama
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

// --- Helper untuk keyboard pilihan dari list
function makeKeyboard(items, dataPrefix) {
  return {
    reply_markup: {
      inline_keyboard: items.map(item => [{ text: item.text, callback_data: `${dataPrefix}:${item.value}` }])
    }
  };
}

// --- START flow & registrasi
bot.onText(/\/start/, async (msg) => {
  const users = loadUsers();
  const id = msg.from.id.toString();

  // Sudah pernah daftar dan sudah di-approve
  if (users[id] && users[id].approved) {
    session[id] = { stage: 'await_account_id' };
    return bot.sendMessage(msg.chat.id, 'Selamat datang di Bot Cloudflare!\n\nMasukkan *Account ID* Cloudflare kamu:', { parse_mode: 'Markdown' });
  }

  // Sudah daftar tapi belum di-approve
  if (users[id] && !users[id].approved) {
    return bot.sendMessage(msg.chat.id, '⏳ Pendaftaran Anda sedang menunggu persetujuan admin. Mohon tunggu.');
  }

  // User baru: simpan ke users.json & kirim notifikasi ke admin
  const waktuDaftar = new Date();
  users[id] = {
    username: msg.from.username || "",
    first_name: msg.from.first_name || "",
    registered_at: waktuDaftar.toISOString(),
    approved: false
  };
  saveUsers(users);

  bot.sendMessage(msg.chat.id, '📝 Pendaftaran berhasil!\nMenunggu persetujuan admin sebelum bisa menggunakan bot.');

  // Kirim notifikasi ke admin
  const namaUser = (msg.from.username ? `@${msg.from.username}` : '') + (msg.from.first_name ? ` (${msg.from.first_name})` : '');
  const notif = `🆕 Permintaan pendaftaran user:\nNama: ${namaUser}\nUser ID: ${id}\nWaktu daftar: ${formatDate(waktuDaftar)}\n\nKlik Approve untuk memberi akses.`;
  bot.sendMessage(ADMIN_TELEGRAM_ID, notif, {
    reply_markup: {
      inline_keyboard: [[{ text: '✔️ Approve user', callback_data: `approve_user:${id}` }]]
    }
  });
});

// --- Admin approval handler
bot.on('callback_query', async (query) => {
  // Approve user baru
  if (query.data && query.data.startsWith('approve_user:')) {
    if (query.from.id.toString() !== ADMIN_TELEGRAM_ID) {
      bot.answerCallbackQuery(query.id, { text: 'Hanya admin yang bisa approve.' });
      return;
    }
    const approveId = query.data.split(':')[1];
    const users = loadUsers();
    if (!users[approveId]) {
      bot.answerCallbackQuery(query.id, { text: 'User tidak ditemukan.' });
      return;
    }
    if (users[approveId].approved) {
      bot.answerCallbackQuery(query.id, { text: 'User sudah di-approve.' });
      return;
    }
    users[approveId].approved = true;
    users[approveId].approved_at = (new Date()).toISOString();
    saveUsers(users);

    // Notifikasi ke admin & user
    bot.sendMessage(query.message.chat.id, `✅ User ${users[approveId].username || users[approveId].first_name || approveId} sudah di-approve!`);
    bot.sendMessage(approveId, '✅ Pendaftaran kamu telah disetujui admin. Silakan /start untuk mulai menggunakan bot.');
    bot.answerCallbackQuery(query.id, { text: 'Berhasil approve user.' });
    return;
  }
  // Handler lain di bawah...
});

// --- Middleware: hanya user approved bisa pakai bot
function ensureApproved(msg, next) {
  const id = (msg.from && msg.from.id ? msg.from.id.toString() : null);
  if (!id) return;
  const users = loadUsers();
  if (!users[id] || !users[id].approved) {
    bot.sendMessage(msg.chat.id, '❌ Anda belum terdaftar atau belum disetujui admin. Ketik /start untuk daftar.');
    return false;
  }
  return true;
}

// --- Handle login stages
bot.on('message', async (msg) => {
  // Ignore /start (karena sudah dihandle di atas)
  if (msg.text && msg.text.startsWith('/start')) return;

  // Cek approval
  if (!ensureApproved(msg)) return;

  const id = msg.from.id.toString();
  if (!session[id] || !session[id].stage) return;

  const user = session[id];

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

// --- Menu utama (inline keyboard) & binding flow
bot.on('callback_query', async (query) => {
  // Handler Approve ada di atas!

  const id = query.from.id.toString();
  const users = loadUsers();
  if (!users[id] || !users[id].approved) {
    bot.answerCallbackQuery(query.id, { text: 'Belum di-approve admin.' });
    return;
  }

  const user = session[id];
  if (!user || !user.stage) {
    bot.answerCallbackQuery(query.id, { text: 'Silakan login dulu.' });
    return;
  }
  const chatId = query.message.chat.id;

  // MENU UTAMA
  if (user.stage === 'logged_in') {
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
        bot.sendMessage(chatId, 'Memuat daftar Worker...');
        try {
          const resp = await axios.get(
            `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts`,
            { headers: { Authorization: `Bearer ${user.api_token}` } }
          );
          if (resp.data && resp.data.result && resp.data.result.length) {
            user._worker_list = resp.data.result.map(w => w.id);
            bot.sendMessage(chatId, 'Pilih Worker yang akan di-binding KV:', makeKeyboard(user._worker_list.map(w => ({ text: w, value: w })), 'bindkv_worker'));
            user.stage = 'binding_select_worker';
          } else {
            bot.sendMessage(chatId, 'Belum ada Worker untuk di-binding.');
          }
        } catch {
          bot.sendMessage(chatId, 'Gagal mengambil daftar Worker.');
        }
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
    return;
  }

  // ========== BINDING FLOW ==========
  // Step: pilih Worker
  if (user.stage === 'binding_select_worker' && query.data.startsWith('bindkv_worker:')) {
    const workerName = query.data.split(':')[1];
    user._binding_worker = workerName;

    bot.sendMessage(chatId, 'Memuat daftar KV Namespace...');
    try {
      const resp = await axios.get(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/storage/kv/namespaces`,
        { headers: { Authorization: `Bearer ${user.api_token}` } }
      );
      if (resp.data && resp.data.result && resp.data.result.length) {
        user._kv_list = resp.data.result.map(kv => ({ id: kv.id, title: kv.title }));
        bot.sendMessage(chatId, 'Pilih KV Namespace yang akan di-binding ke Worker:', makeKeyboard(user._kv_list.map(kv => ({ text: kv.title, value: kv.id })), 'bindkv_kv'));
        user.stage = 'binding_select_kv';
      } else {
        bot.sendMessage(chatId, 'Belum ada KV Namespace untuk di-binding.');
        user.stage = 'logged_in';
      }
    } catch {
      bot.sendMessage(chatId, 'Gagal mengambil daftar KV Namespace.');
      user.stage = 'logged_in';
    }
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Step: pilih KV
  if (user.stage === 'binding_select_kv' && query.data.startsWith('bindkv_kv:')) {
    const kvId = query.data.split(':')[1];
    const workerName = user._binding_worker;

    bot.sendMessage(chatId, `Membinding KV "${kvId}" ke Worker "${workerName}"...`);
    try {
      const resp = await axios.patch(
        `https://api.cloudflare.com/client/v4/accounts/${user.account_id}/workers/scripts/${workerName}/bindings`,
        [
          {
            name: "MY_KV", // Bisa diganti sesuai kebutuhan
            type: "kv_namespace",
            namespace_id: kvId
          }
        ],
        {
          headers: {
            Authorization: `Bearer ${user.api_token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      if (resp.data && resp.data.success) {
        bot.sendMessage(chatId, `✅ Sukses binding KV ke Worker!\n\nWorker: ${workerName}\nKV: ${kvId}`, mainMenu());
      } else {
        bot.sendMessage(chatId, `❌ Gagal binding KV ke Worker. ${resp.data.errors ? JSON.stringify(resp.data.errors) : ''}`, mainMenu());
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal binding KV ke Worker.', mainMenu());
    }
    user.stage = 'logged_in';
    delete user._binding_worker;
    delete user._kv_list;
    delete user._worker_list;
    bot.answerCallbackQuery(query.id);
    return;
  }
});

// --- Handler fitur input lanjutan (worker name / KV name / hapus dll)
bot.on('message', async (msg) => {
  if (!ensureApproved(msg)) return;

  const id = msg.from.id.toString();
  if (!session[id] || !session[id].stage) return;
  const user = session[id];

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
    try {
      const code = (await axios.get(fileUrl)).data;
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

console.log('Bot Cloudflare Telegram siap dijalankan!');
