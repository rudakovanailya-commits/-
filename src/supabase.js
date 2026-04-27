const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

/** Полный URL; если в .env только хост — добавим https:// */
function normalizeSupabaseUrl(raw) {
  const s = (raw || '').trim();
  if (!s) {
    return '';
  }
  if (/^https?:\/\//i.test(s)) {
    return s;
  }
  return `https://${s.replace(/^\/+/, '')}`;
}

const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!url || !key) {
  console.error(
    'Предупреждение: в .env не заданы SUPABASE_URL и/или SUPABASE_SERVICE_ROLE_KEY. ' +
      'Сохранение в Supabase не будет работать, пока не заполните переменные и не перезапустите бота.'
  );
}

/** null, если .env не настроен — иначе при старте был бы crash createClient */
const supabase = url && key ? createClient(url, key) : null;

function getClient() {
  if (!supabase) {
    const err = new Error(
      'Supabase не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env'
    );
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }
  return supabase;
}

function getBucketName() {
  return process.env.SUPABASE_BUCKET || 'invoices';
}

/**
 * @param {string} storagePath путь внутри бакета
 * @param {Buffer} buffer
 * @param {{ contentType?: string }} [opts]
 * @returns {Promise<{ publicUrl: string }>}
 */
async function uploadInvoiceFile(storagePath, buffer, opts = {}) {
  const c = getClient();
  const bucket = getBucketName();
  const { error: uploadError } = await c.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: opts.contentType || 'application/octet-stream',
      upsert: false
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = c.storage.from(bucket).getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl };
}

/**
 * @param {object} row
 * @returns {Promise<string>} id записи
 */
async function createExpenseRow(row) {
  const c = getClient();
  const createdAt = row.created_at ?? new Date().toISOString();
  const { data, error } = await c
    .from('expenses')
    .insert({
      file_url: row.file_url,
      file_name: row.file_name,
      category_id: row.category_id,
      category: row.category,
      subcategory_id: row.subcategory_id,
      subcategory: row.subcategory,
      comment: row.comment ?? '',
      status: 'new',
      user_id: row.user_id,
      user_name: row.user_name ?? null,
      created_at: createdAt
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }
  return data.id;
}

async function updateExpenseStatus(id, status) {
  const c = getClient();
  const { data, error } = await c
    .from('expenses')
    .update({ status })
    .eq('id', id)
    .select('id')
    .single();

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Для кнопок бухгалтера: владелец и данные для уведомления
 * @param {string} id uuid
 */
async function getExpenseByIdForAccountant(id) {
  const c = getClient();
  const { data, error } = await c
    .from('expenses')
    .select('user_id, user_name, file_name, category, subcategory')
    .eq('id', id)
    .single();

  if (error) {
    throw error;
  }
  return data;
}

/**
 * @param {number|string} userId
 * @param {number} [limit=5]
 */
async function listUserExpenses(userId, limit = 5) {
  const c = getClient();
  const { data, error } = await c
    .from('expenses')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }
  return data || [];
}

/**
 * Активный пользователь по chat_id (Telegram), не по внутреннему id (uuid).
 * maybeSingle: 0 строк — data null, без «ошибки uuid» от .single() / приведения типа.
 * @param {number|string} chatId
 * @returns {Promise<object | null>}
 */
async function getUser(chatId) {
  const c = getClient();
  const { data, error } = await c
    .from('users')
    .select('*')
    .eq('chat_id', chatId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ?? null;
}

/**
 * Запись по коду (любое состояние is_active), для разделения «нет кода» / «уже использован»
 * @param {string} code
 * @returns {Promise<object | null>}
 */
async function getInviteByCode(code) {
  const c = getClient();
  const trimmed = String(code || '').trim();
  if (!trimmed) {
    return null;
  }
  const { data, error } = await c
    .from('invite_codes')
    .select('*')
    .eq('code', trimmed)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ?? null;
}

/**
 * @param {{ chat_id: number, name: string, role: string, is_active?: boolean }} row
 */
async function upsertUserFromInvite(row) {
  const c = getClient();
  const { error } = await c.from('users').upsert(
    {
      chat_id: row.chat_id,
      name: row.name,
      role: row.role,
      is_active: row.is_active !== false
    },
    { onConflict: 'chat_id' }
  );

  if (error) {
    throw error;
  }
}

/**
 * Одноразовый код: пометить использованным и сохранить кто вошёл
 * @param {string} code
 * @param {number|string} usedByChatId
 */
async function markInviteCodeUsed(code, usedByChatId) {
  const c = getClient();
  const { error } = await c
    .from('invite_codes')
    .update({
      is_active: false,
      used_by: usedByChatId
    })
    .eq('code', String(code).trim());

  if (error) {
    throw error;
  }
}

/**
 * @param {{ code: string, role: string, created_by: number, is_active?: boolean }} row
 */
async function createInviteCodeRow(row) {
  const c = getClient();
  const { error } = await c.from('invite_codes').insert({
    code: row.code,
    role: row.role,
    created_by: row.created_by,
    is_active: row.is_active !== false
  });

  if (error) {
    throw error;
  }
}

/**
 * @returns {Promise<object[]>}
 */
async function listExpenses() {
  const c = getClient();
  const { data, error } = await c
    .from('expenses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }
  return data || [];
}

/**
 * @param {number} [limit=5]
 * @returns {Promise<object[]>}
 */
async function listNewExpenses(limit = 5) {
  const c = getClient();
  const { data, error } = await c
    .from('expenses')
    .select('*')
    .eq('status', 'new')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }
  return data || [];
}

module.exports = {
  supabase,
  getClient,
  getBucketName,
  uploadInvoiceFile,
  createExpenseRow,
  updateExpenseStatus,
  getExpenseByIdForAccountant,
  listUserExpenses,
  getUser,
  getInviteByCode,
  upsertUserFromInvite,
  markInviteCodeUsed,
  createInviteCodeRow,
  listExpenses,
  listNewExpenses
};
