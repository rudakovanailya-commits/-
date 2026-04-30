const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TelegramBot = require('node-telegram-bot-api');
const { categories, getCategoryById, getSubcategoryByIds } = require('./categories');
const { buildFileName } = require('./buildFileName');
const {
  uploadInvoiceFile,
  createExpenseRow,
  updateExpenseStatus,
  getExpenseByIdForAccountant,
  listUserExpenses,
  listNewExpenses,
  getUser,
  setUserWelcomed,
  getInviteByCode,
  upsertUserFromInvite,
  markInviteCodeUsed,
  createInviteCodeRow
} = require('./supabase');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ACCOUNTANT_CHAT_ID = process.env.ACCOUNTANT_CHAT_ID;
const TELEGRAM_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');

const MSG_NO_ACCESS = '⛔ Нет доступа\nВведите код:\n/start CODE';
const MSG_WELCOME_START = '📎 Отправьте счёт';
const MSG_CODE_NOT_VALID = '❌ Код недействителен';
const MSG_CODE_ALREADY_USED = '❌ Код уже использован';
const MSG_CODE_GRANTED = '✅ Доступ открыт. Отправьте счёт';
const MSG_WELCOME_FIRST =
  'Отправьте счёт — файлом или перешлите из чата 👇';

if (!TOKEN) {
  console.error('Укажите TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

/** 0 = выкл. Иначе: мс до авто-сброса сессии (см. processAndSave). Можно задать через process.env.SESSION_TTL_MS */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 0;

const MSG_FILE_TELEGRAM =
  'Не удалось получить файл, попробуйте ещё раз';
const MSG_SAVE_SUPABASE = 'Ошибка при сохранении. Попробуйте позже';
const MSG_SESSION_INCOMPLETE =
  'Не удалось сохранить: сессия неполная. Отправьте счёт снова.';
const MSG_SESSION_STALE = 'Сессия устарела. Отправьте счёт заново.';
const MSG_ACTION_CANCELLED = 'Действие отменено';
const MSG_NO_ACTIVE_ACTION = 'Нет активного действия';
const MSG_USE_CATEGORY_BUTTONS = 'Выберите категорию кнопками';
const MSG_USE_SUBCATEGORY_BUTTONS = 'Выберите подкатегорию кнопками';
const MSG_SEND_FILE_OR_PHOTO = 'Отправьте файл или фото счёта';

/**
 * Сессия: загрузка счёта (await_*) или ввод произвольного вопроса по счёту (waiting_question)
 * @type {Map<number, object>}
 */
const userSessions = new Map();

/** Отмена ввода произвольного вопроса по счёту (бухгалтер) */
const CANCEL_ACCOUNTANT_QUESTION_CB = 'cancel_question';

/** callback_data кнопок «Отмена» (ввод счёта) */
const CANCEL_INPUT_CB = 'cancel_input';

function buildCancelButtonRow() {
  return [{ text: 'Отмена', callback_data: CANCEL_INPUT_CB }];
}

async function performCancelByCommand(chatId) {
  if (userSessions.has(chatId)) {
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, MSG_ACTION_CANCELLED);
  } else {
    await bot.sendMessage(chatId, MSG_NO_ACTIVE_ACTION);
  }
}

async function sendStaleAndReset(chatId) {
  userSessions.delete(chatId);
  try {
    await bot.sendMessage(chatId, MSG_SESSION_STALE);
  } catch (_) {}
}

function clearSessionForChat(chatId) {
  userSessions.delete(chatId);
}

function needsAutoWelcome(u) {
  return Boolean(u && u.is_welcomed !== true);
}

async function markWelcomedAfterFileIfNeeded(chatId, u) {
  if (!needsAutoWelcome(u)) {
    return;
  }
  try {
    await setUserWelcomed(chatId);
  } catch (e) {
    console.error('setUserWelcomed (первый файл/фото):', e);
  }
}

function formatUserLabel(from) {
  if (!from) {
    return 'Пользователь';
  }
  if (from.username) {
    return `@${from.username}`;
  }
  if (from.first_name) {
    return String(from.first_name);
  }
  return 'Пользователь';
}

function isSessionExpired(s) {
  if (!SESSION_TTL_MS) {
    return false;
  }
  const t = s.sessionCreatedAt;
  if (typeof t !== 'number') {
    return false;
  }
  return Date.now() - t > SESSION_TTL_MS;
}

function buildCategoryKeyboard() {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const slice = categories.slice(i, i + 2);
    rows.push(
      slice.map((c) => ({
        text: c.title,
        callback_data: `category:${c.id}`
      }))
    );
  }
  rows.push(buildCancelButtonRow());
  return { inline_keyboard: rows };
}

function buildSubcategoryKeyboard(categoryId) {
  const cat = getCategoryById(categoryId);
  if (!cat) {
    return { inline_keyboard: [] };
  }
  const rows = [];
  for (let i = 0; i < cat.subcategories.length; i += 2) {
    const slice = cat.subcategories.slice(i, i + 2);
    rows.push(
      slice.map((s) => ({
        text: s.title,
        callback_data: `subcategory:${categoryId}:${s.id}`
      }))
    );
  }
  rows.push(buildCancelButtonRow());
  return { inline_keyboard: rows };
}

function buildSkipCommentKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⏭ Пропустить', callback_data: 'skip_comment' },
        { text: 'Отмена', callback_data: CANCEL_INPUT_CB }
      ]
    ]
  };
}

function buildAccountantActions(expenseId) {
  const idStr = String(expenseId);
  return {
    inline_keyboard: [
      [{ text: '✅ Принято', callback_data: `accept:${idStr}` }],
      [{ text: '❓ Вопрос', callback_data: `question:${idStr}` }]
    ]
  };
}

/** Карточка для /new (HTML) */
function formatNewExpenseListCard(row) {
  const who = escapeHtml(String(row.user_name || row.user_id || '—'));
  const cat = escapeHtml(String(row.category || '—'));
  const sub = row.subcategory
    ? escapeHtml(String(row.subcategory))
    : (row.subcategory_id ? escapeHtml(String(row.subcategory_id)) : '—');
  return [
    '📥 Новый счёт',
    '',
    `👤 ${who}`,
    `📄 ${escapeHtml(String(row.file_name))}`,
    `📂 ${cat} → ${sub}`,
    '',
    `🔗 <a href="${escapeAttrUrl(row.file_url)}">Ссылка на файл</a>`
  ].join('\n');
}

function hasStaffRole(user) {
  if (!user) {
    return false;
  }
  return user.role === 'admin' || user.role === 'accountant';
}

/**
 * Входящие сообщения диалога «вопрос по счёту» только для бухгалтерского чата
 * @param {number} chatId
 * @param {*} u getUser(chatId)
 */
function isAccountantForIncomingMessages(chatId, u) {
  if (!u || !hasStaffRole(u)) {
    return false;
  }
  const envId = ACCOUNTANT_CHAT_ID ? String(ACCOUNTANT_CHAT_ID).trim() : '';
  if (envId) {
    return String(chatId) === envId;
  }
  return true;
}

/**
 * @param {*} query
 * @param {string} expenseId
 */
async function beginAccountantQuestionDialog(query, expenseId) {
  const staffChatId = query.message ? query.message.chat.id : query.from.id;
  let staffUser;
  try {
    staffUser = await getUser(staffChatId);
  } catch (e) {
    console.error('getUser beginAccountantQuestionDialog:', e);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Ошибка доступа.',
        show_alert: true
      });
    } catch (_) {}
    return;
  }

  if (!isAccountantForIncomingMessages(staffChatId, staffUser)) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Нет доступа.',
        show_alert: true
      });
    } catch (_) {}
    return;
  }

  let row;
  try {
    row = await getExpenseByIdForAccountant(expenseId);
  } catch (e) {
    console.error('getExpenseByIdForAccountant:', e);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Запись не найдена',
        show_alert: true
      });
    } catch (_) {}
    return;
  }

  const userChatId = row.user_id;
  if (!userChatId) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Нет пользователя в записи.',
        show_alert: true
      });
    } catch (_) {}
    return;
  }

  userSessions.set(staffChatId, {
    step: 'waiting_question',
    expenseId,
    userChatId,
    sessionCreatedAt: Date.now()
  });

  try {
    await bot.answerCallbackQuery(query.id, { text: 'Введите вопрос текстом…' });
  } catch (_) {}

  try {
    await bot.sendMessage(staffChatId, '✍️ Введите вопрос для пользователя', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Отмена', callback_data: CANCEL_ACCOUNTANT_QUESTION_CB }]
        ]
      }
    });
  } catch (e) {
    console.error('beginAccountantQuestionDialog send:', e);
    userSessions.delete(staffChatId);
  }
}

/**
 * @param {*} query
 * @param {string} expenseId
 */
async function applyAccountantExpenseAction(query, expenseId, action) {
  if (action === 'question') {
    await beginAccountantQuestionDialog(query, expenseId);
    return;
  }

  const status = 'in_progress';
  let row;
  try {
    row = await getExpenseByIdForAccountant(expenseId);
  } catch (e) {
    console.error('getExpenseByIdForAccountant:', e);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Запись не найдена',
        show_alert: true
      });
    } catch (_) {}
    return;
  }

  try {
    await updateExpenseStatus(expenseId, status);
  } catch (e) {
    console.error('updateExpenseStatus:', e);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Ошибка БД', show_alert: true });
    } catch (_) {}
    return;
  }

  console.log('STATUS UPDATED:', expenseId, status);
  try {
    await bot.answerCallbackQuery(query.id, { text: 'Готово' });
  } catch (_) {}

  const userChatId = row.user_id;
  if (!userChatId) {
    return;
  }
  try {
    await bot.sendMessage(userChatId, '✅ Счёт принят в работу');
    console.log('USER NOTIFIED:', userChatId);
  } catch (notifyErr) {
    console.error('Пользователю: не удалось отправить:', notifyErr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttrUrl(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * @param {string} fileId
 * @param {string} [mimeType]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function downloadTelegramFile(fileId, mimeType) {
  let file;
  try {
    file = await bot.getFile(fileId);
  } catch (e) {
    const err = new Error('getFile_failed');
    err.code = 'TELEGRAM_FILE';
    err.cause = e;
    throw err;
  }
  if (!file) {
    const err = new Error('no_file');
    err.code = 'TELEGRAM_FILE';
    throw err;
  }
  if (!file.file_path) {
    const err = new Error('no_file_path');
    err.code = 'NO_FILE_PATH';
    throw err;
  }
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`download_http_${res.status}`);
    err.code = 'TELEGRAM_FILE';
    throw err;
  }
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType =
    mimeType ||
    (file.file_path.endsWith('.png') ? 'image/png' : null) ||
    (file.file_path.match(/\.jpe?g$/i) ? 'image/jpeg' : null) ||
    'application/octet-stream';
  return { buffer, contentType };
}

/**
 * @param {number} chatId
 * @param {*} session
 * @param {string} comment
 */
async function processAndSave(chatId, session, comment) {
  if (isSessionExpired(session)) {
    await bot.sendMessage(
      chatId,
      'Сессия слишком старая. Отправьте счёт снова (/start).'
    );
    userSessions.delete(chatId);
    return;
  }
  if (
    !session.fileId ||
    typeof session.fileId !== 'string' ||
    !session.category_id ||
    !String(session.category_id).trim() ||
    !session.category ||
    !String(session.category).trim() ||
    !session.subcategory_id ||
    !String(session.subcategory_id).trim() ||
    !session.subcategory ||
    !String(session.subcategory).trim()
  ) {
    await bot.sendMessage(chatId, MSG_SESSION_INCOMPLETE);
    userSessions.delete(chatId);
    return;
  }

  // В Storage — только result buildFileName; исходное имя (кириллица, №, даты) не в path
  const safeFileName = buildFileName(session.originalFileName);
  const storagePath = `telegram/${safeFileName}`;

  let buffer;
  let contentType;
  try {
    const got = await downloadTelegramFile(session.fileId, session.mimeType);
    buffer = got.buffer;
    contentType = got.contentType;
  } catch (e) {
    console.error('Telegram file:', e);
    await bot.sendMessage(chatId, MSG_FILE_TELEGRAM);
    userSessions.delete(chatId);
    return;
  }

  let publicUrl;
  try {
    const out = await uploadInvoiceFile(storagePath, buffer, {
      contentType
    });
    publicUrl = out.publicUrl;
  } catch (e) {
    console.error('Supabase upload:', e);
    if (e && String(e.message || e).toLowerCase().includes('invalid key')) {
      console.error(
        '→ Путь в Storage должен быть без кириллицы и «№». ' +
          'Проверьте, что в коде используется buildFileName() для имени файла в пути.'
      );
    }
    await bot.sendMessage(chatId, MSG_SAVE_SUPABASE);
    return;
  }
  console.log('файл загружен в Supabase', storagePath);

  let expenseId;
  try {
    expenseId = await createExpenseRow({
      file_url: publicUrl,
      file_name: session.originalFileName,
      category_id: session.category_id,
      category: session.category,
      subcategory_id: session.subcategory_id,
      subcategory: session.subcategory,
      comment: comment || '',
      user_id: chatId,
      user_name: session.userName || 'Пользователь'
    });
  } catch (e) {
    const code = e && e.code;
    const msg = e && e.message;
    console.error('Supabase insert:', e);
    if (code === 'PGRST204' || (msg && String(msg).includes('column'))) {
      console.error(
        '→ В таблице expenses нет полей, которые ожидает бот. ' +
          'Выполните SQL из: supabase/migrations/001_expenses_bot_columns.sql ' +
          'и при необходимости supabase/migrations/002_expenses_user_name.sql'
      );
    }
    await bot.sendMessage(chatId, MSG_SAVE_SUPABASE);
    return;
  }
  console.log('запись создана', { id: expenseId, chatId });

  try {
    if (ACCOUNTANT_CHAT_ID) {
      const who = escapeHtml(String(session.userName || 'Пользователь'));
      const text = [
        '📥 Новый счёт',
        '',
        `👤 ${who}`,
        `📄 ${escapeHtml(session.originalFileName)}`,
        `📂 ${escapeHtml(session.category)} → ${escapeHtml(session.subcategory)}`,
        '',
        `🔗 <a href="${escapeAttrUrl(publicUrl)}">Ссылка на файл</a>`
      ].join('\n');

      await bot.sendMessage(ACCOUNTANT_CHAT_ID, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: buildAccountantActions(expenseId)
      });
    } else {
      console.warn('ACCOUNTANT_CHAT_ID не задан — уведомление бухгалтеру не отправлено.');
    }

    const userText = [
      '✅ Счёт сохранён',
      '',
      `📄 ${escapeHtml(session.originalFileName)}`,
      `📂 ${escapeHtml(session.category)} → ${escapeHtml(session.subcategory)}`
    ].join('\n');

    await bot.sendMessage(chatId, userText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (sendErr) {
    console.error('Ошибка отправки в Telegram после сохранения в БД:', sendErr);
  } finally {
    userSessions.delete(chatId);
    console.log('сессия очищена', chatId);
  }
}

bot.onText(/^\/start(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = (match[1] || '').trim();
  if (!code) {
    return;
  }
  clearSessionForChat(chatId);
  try {
    const already = await getUser(chatId);
    if (already) {
      await bot.sendMessage(
        chatId,
        'У вас уже есть доступ. Команда /start — сброс сессии. Отправьте счёт.'
      );
      try {
        await setUserWelcomed(chatId);
      } catch (e) {
        console.error('setUserWelcomed (уже с доступом):', e);
      }
      return;
    }
    const invite = await getInviteByCode(code);
    if (!invite) {
      await bot.sendMessage(chatId, MSG_CODE_NOT_VALID);
      return;
    }
    if (!invite.is_active) {
      await bot.sendMessage(chatId, MSG_CODE_ALREADY_USED);
      return;
    }
    const userName = formatUserLabel(msg.from);
    await upsertUserFromInvite({
      chat_id: chatId,
      name: userName,
      role: invite.role || 'user',
      is_active: true
    });
    await markInviteCodeUsed(invite.code, chatId);
    await bot.sendMessage(chatId, MSG_CODE_GRANTED);
    try {
      await setUserWelcomed(chatId);
    } catch (e) {
      console.error('setUserWelcomed (код):', e);
    }
  } catch (e) {
    console.error('Ошибка /start (код):', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Не удалось применить код. Попробуйте позже.'
      );
    } catch (_) {}
  }
});

bot.onText(/^\/start(?:@\w+)?\s*$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    clearSessionForChat(chatId);
    const u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(
        chatId,
        '⛔ Нет доступа\nВведите код:\n/start CODE'
      );
      return;
    }
    await bot.sendMessage(chatId, MSG_WELCOME_START);
    try {
      await setUserWelcomed(chatId);
    } catch (e) {
      console.error('setUserWelcomed (/start):', e);
    }
  } catch (e) {
    console.error('Ошибка /start:', e);
  }
});

bot.onText(/^\/cancel(?:@\w+)?\s*$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(chatId, MSG_NO_ACCESS);
      return;
    }
    await performCancelByCommand(chatId);
  } catch (e) {
    console.error('Ошибка /cancel:', e);
  }
});

bot.onText(/\/new(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(chatId, MSG_NO_ACCESS);
      return;
    }
    if (!hasStaffRole(u)) {
      try {
        await bot.sendMessage(
          chatId,
          '⛔ Команда /new доступна только бухгалтеру.'
        );
      } catch (_) {}
      return;
    }
  } catch (e) {
    console.error('getUser /new:', e);
    return;
  }
  try {
    const rows = await listNewExpenses(5);
    if (rows.length === 0) {
      await bot.sendMessage(chatId, 'Нет новых счетов');
      return;
    }
    for (const row of rows) {
      const text = formatNewExpenseListCard(row);
      await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: buildAccountantActions(row.id)
      });
    }
  } catch (e) {
    console.error('Ошибка /new:', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Не удалось загрузить список. Попробуйте позже.'
      );
    } catch (_) {}
  }
});

bot.onText(/^\/list(?:@\w+)?\s*$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(chatId, MSG_NO_ACCESS);
      return;
    }
  } catch (e) {
    console.error('getUser /list:', e);
    return;
  }
  try {
    const data = await listUserExpenses(chatId, 5);
    if (!data.length) {
      await bot.sendMessage(chatId, 'У вас нет счетов');
      return;
    }
    const text = data
      .map(
        (e) =>
          `📄 ${e.file_name || '—'}
📂 ${e.category || '-'}${e.subcategory != null && String(e.subcategory).trim() !== '' ? ` → ${e.subcategory}` : ''}
📊 ${e.status || '—'}
`
      )
      .join('\n');
    await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch (e) {
    console.error('Ошибка /list:', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Не удалось загрузить список. Попробуйте позже.'
      );
    } catch (_) {}
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.document) {
    return;
  }
  let u;
  try {
    u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(chatId, MSG_NO_ACCESS);
      return;
    }
  } catch (e) {
    console.error('getUser (document):', e);
    return;
  }
  try {
    await markWelcomedAfterFileIfNeeded(chatId, u);
    const doc = msg.document;
    const originalFileName = doc.file_name || `file-${Date.now()}.bin`;
    userSessions.set(chatId, {
      fileId: doc.file_id,
      originalFileName,
      userName: formatUserLabel(msg.from),
      mimeType: doc.mime_type,
      step: 'await_category',
      category_id: null,
      category: null,
      subcategory_id: null,
      subcategory: null,
      sessionCreatedAt: Date.now()
    });
    console.log('новый файл получен', {
      chatId,
      kind: 'document',
      originalFileName
    });
    await bot.sendMessage(chatId, '📁 Выберите категорию:', {
      reply_markup: buildCategoryKeyboard()
    });
  } catch (e) {
    console.error('document:', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Не удалось обработать файл. Попробуйте ещё раз.'
      );
    } catch (_) {}
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.photo || msg.photo.length === 0) {
    return;
  }
  let u;
  try {
    u = await getUser(chatId);
    if (!u) {
      await bot.sendMessage(chatId, MSG_NO_ACCESS);
      return;
    }
  } catch (e) {
    console.error('getUser (photo):', e);
    return;
  }
  try {
    await markWelcomedAfterFileIfNeeded(chatId, u);
    const best = msg.photo[msg.photo.length - 1];
    const originalFileName = 'photo.jpg';
    userSessions.set(chatId, {
      fileId: best.file_id,
      originalFileName,
      userName: formatUserLabel(msg.from),
      mimeType: 'image/jpeg',
      step: 'await_category',
      category_id: null,
      category: null,
      subcategory_id: null,
      subcategory: null,
      sessionCreatedAt: Date.now()
    });
    console.log('новый файл получен', {
      chatId,
      kind: 'photo',
      originalFileName
    });
    await bot.sendMessage(chatId, '📷 Выберите категорию:', {
      reply_markup: buildCategoryKeyboard()
    });
  } catch (e) {
    console.error('photo:', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Не удалось обработать фото. Попробуйте ещё раз.'
      );
    } catch (_) {}
  }
});

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
    return;
  }
  const chatId = msg.chat.id;
  let u;
  try {
    u = await getUser(chatId);
  } catch (e) {
    console.error('getUser (message):', e);
    try {
      await bot.sendMessage(
        chatId,
        '❌ Сервис временно недоступен. Попробуйте позже.'
      );
    } catch (_) {}
    return;
  }
  if (!u) {
    await bot.sendMessage(chatId, MSG_NO_ACCESS);
    return;
  }

  const s = userSessions.get(chatId);

  if (s?.step === 'waiting_question' && isAccountantForIncomingMessages(chatId, u)) {
    const trimmed = msg.text ? String(msg.text).trim() : '';
    if (!trimmed) {
      await bot.sendMessage(chatId, 'Пришлите текст вопроса одним сообщением.');
      return;
    }
    const expenseId = s.expenseId;
    const userChatId = s.userChatId;
    if (!expenseId || userChatId == null) {
      userSessions.delete(chatId);
      await bot.sendMessage(
        chatId,
        'Сессия была с некорректными данными. Нажмите «❓ Вопрос» по счёту снова.'
      );
      return;
    }
    try {
      await updateExpenseStatus(expenseId, 'need_info');
    } catch (e) {
      console.error('updateExpenseStatus (вопрос бухгалтера):', e);
      await bot.sendMessage(
        chatId,
        '❌ Не удалось обновить статус в базе. Попробуйте позже.'
      );
      return;
    }
    const userPayload = [
      `❓ Вопрос по счёту №${expenseId}:`,
      '',
      trimmed,
      '',
      '✍️ Ответьте на это сообщение'
    ].join('\n');
    try {
      await bot.sendMessage(userChatId, userPayload);
      console.log('Вопрос по счёту отправлен пользователю:', { userChatId, expenseId });
    } catch (e) {
      console.error('отправка вопроса пользователю:', e);
      await bot.sendMessage(chatId, '❌ Не удалось отправить сообщение пользователю.');
      return;
    }
    userSessions.delete(chatId);
    try {
      await bot.sendMessage(chatId, '✅ Вопрос отправлен');
    } catch (_) {}
    return;
  }

  if (msg.text && msg.text.toLowerCase().includes('новый пользователь')) {
    if (hasStaffRole(u)) {
      try {
        await bot.sendMessage(chatId, 'Создать код приглашения?', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔑 Создать код', callback_data: 'create_invite' }]
            ]
          }
        });
      } catch (e) {
        console.error('приглашение (текст):', e);
      }
    }
    return;
  }

  if (msg.text) {
    if (s && s.step === 'await_category') {
      await bot.sendMessage(chatId, MSG_USE_CATEGORY_BUTTONS);
      return;
    }
    if (s && s.step === 'await_subcategory') {
      await bot.sendMessage(chatId, MSG_USE_SUBCATEGORY_BUTTONS);
      return;
    }
    if (s && s.step === 'await_comment') {
      const comment = msg.text.trim();
      try {
        await processAndSave(chatId, s, comment);
      } catch (e) {
        console.error('save (text comment):', e);
        await bot.sendMessage(chatId, MSG_SAVE_SUPABASE);
      }
      return;
    }
    if (!s) {
      if (needsAutoWelcome(u)) {
        try {
          await bot.sendMessage(chatId, MSG_WELCOME_FIRST);
          await setUserWelcomed(chatId);
        } catch (e) {
          console.error('привет (текст):', e);
        }
      } else {
        await bot.sendMessage(chatId, MSG_SEND_FILE_OR_PHOTO);
      }
    }
    return;
  }

  if (s && s.step === 'await_comment') {
    return;
  }

  if (needsAutoWelcome(u) && !s && !msg.document && !msg.photo) {
    try {
      await bot.sendMessage(chatId, MSG_WELCOME_FIRST);
      await setUserWelcomed(chatId);
    } catch (e) {
      console.error('привет (стикер/пр.):', e);
    }
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message
    ? query.message.chat.id
    : query.from.id;

  try {
    const isStaffAction =
      data === 'create_invite' ||
      data === CANCEL_ACCOUNTANT_QUESTION_CB ||
      data.startsWith('accept:') ||
      data.startsWith('question:');
    if (!isStaffAction) {
      const au = await getUser(query.from.id);
      if (!au) {
        try {
          await bot.answerCallbackQuery(query.id, {
            text: '⛔ Нет доступа',
            show_alert: true
          });
        } catch (_) {}
        return;
      }
    }

    if (data === CANCEL_INPUT_CB) {
      if (userSessions.has(chatId)) {
        userSessions.delete(chatId);
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, MSG_ACTION_CANCELLED);
      } else {
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, MSG_NO_ACTIVE_ACTION);
      }
      return;
    }

    if (data === CANCEL_ACCOUNTANT_QUESTION_CB) {
      const au = await getUser(query.from.id);
      if (!isAccountantForIncomingMessages(chatId, au)) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Нет доступа.',
          show_alert: true
        });
        return;
      }
      const sess = userSessions.get(chatId);
      if (!sess || sess.step !== 'waiting_question') {
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, MSG_NO_ACTIVE_ACTION);
        return;
      }
      userSessions.delete(chatId);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, MSG_ACTION_CANCELLED);
      return;
    }

    if (data.startsWith('category:')) {
      const catId = data.slice(9);
      const cat = getCategoryById(catId);
      const s = userSessions.get(chatId);
      if (!s || s.step !== 'await_category' || !cat) {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      s.category_id = cat.id;
      s.category = cat.title;
      s.step = 'await_subcategory';
      if (typeof s.sessionCreatedAt !== 'number') {
        s.sessionCreatedAt = Date.now();
      }
      userSessions.set(chatId, s);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '📂 Выберите подкатегорию:', {
        reply_markup: buildSubcategoryKeyboard(cat.id)
      });
      return;
    }

    if (data.startsWith('subcategory:')) {
      const rest = data.slice(12);
      const col = rest.indexOf(':');
      if (col === -1) {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const parentCatId = rest.slice(0, col);
      const subId = rest.slice(col + 1);
      const s = userSessions.get(chatId);
      if (s && s.step !== 'await_subcategory') {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      if (!s || s.category_id !== parentCatId) {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const found = getSubcategoryByIds(parentCatId, subId);
      if (!found) {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      s.subcategory_id = found.subcategory.id;
      s.subcategory = found.subcategory.title;
      s.step = 'await_comment';
      if (typeof s.sessionCreatedAt !== 'number') {
        s.sessionCreatedAt = Date.now();
      }
      userSessions.set(chatId, s);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        '✏️ Напишите комментарий к счёту (или нажмите «Пропустить»).',
        { reply_markup: buildSkipCommentKeyboard() }
      );
      return;
    }

    if (data === 'skip_comment') {
      const s = userSessions.get(chatId);
      if (!s || s.step !== 'await_comment') {
        await sendStaleAndReset(chatId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: 'Сохраняю…' });
      try {
        await processAndSave(chatId, s, '');
      } catch (e) {
        console.error('save (skip):', e);
        await bot.sendMessage(chatId, MSG_SAVE_SUPABASE);
      }
      return;
    }

    if (data === 'create_invite') {
      const actor = await getUser(query.from.id);
      if (!hasStaffRole(actor)) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Нет доступа.',
          show_alert: true
        });
        return;
      }
      let code = '';
      let createdOk = false;
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
        try {
          await createInviteCodeRow({
            code,
            role: 'user',
            created_by: query.from.id,
            is_active: true
          });
          createdOk = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!createdOk) {
        console.error('create_invite insert:', lastErr);
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Ошибка БД', show_alert: true });
        } catch (_) {}
        return;
      }
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Готово' });
      } catch (_) {}
      const text = TELEGRAM_BOT_USERNAME
        ? `🔑 Код приглашения:\n\n${code}\n\n🔗 Ссылка:\nhttps://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(code)}\n\nОтправьте пользователю`
        : `🔑 Код приглашения:\n\n${code}\n\nОткройте бота и введите:\n/start ${code}\n\nОтправьте пользователю`;
      await bot.sendMessage(query.from.id, text);
      return;
    }

    if (data.startsWith('accept:') || data.startsWith('question:')) {
      const actor = await getUser(query.from.id);
      if (!hasStaffRole(actor)) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Нет доступа.',
          show_alert: true
        });
        return;
      }
      const action = data.startsWith('accept:') ? 'accept' : 'question';
      const id = (
        action === 'accept' ? data.slice('accept:'.length) : data.slice('question:'.length)
      ).trim();
      if (!id) {
        await bot.answerCallbackQuery(query.id, { text: 'Некорректный id' });
        return;
      }
      try {
        await applyAccountantExpenseAction(query, id, action);
      } catch (e) {
        console.error('accept/question:', e);
        try {
          await bot.answerCallbackQuery(query.id, {
            text: 'Ошибка обновления',
            show_alert: true
          });
        } catch (_) {}
      }
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error('callback_query:', e);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Ошибка',
        show_alert: true
      });
    } catch (_) {}
  }
});

bot.on('polling_error', (err) => {
  console.error('polling_error:', err);
});

process.on('unhandledRejection', (r) => {
  console.error('unhandledRejection', r);
});

console.log('Бот запущен. Нажмите Ctrl+C для остановки.');
