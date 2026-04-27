/**
 * Пример загрузки из веб-приложения: тот же buildFileName, путь web/...
 * Скопируйте `src/buildFileName.js` в фронт или подключайте из общего пакета.
 *
 * @example
 * const { buildFileName } = require('../src/buildFileName');
 * const { createClient } = require('@supabase/supabase-js');
 * const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
 * const file = // <input type="file" />
 * const originalName = file.name;
 * const safeFileName = buildFileName(originalName);
 * await supabase.storage.from('invoices').upload(`web/${safeFileName}`, file, { ... });
 * await supabase.from('expenses').insert({ file_name: originalName, ... });
 */
const { buildFileName } = require('../src/buildFileName');

/**
 * @param {*} supabase клиент @supabase/supabase-js
 * @param {File|Blob} file
 * @param {object} [opts] опции supabase storage.upload
 */
async function uploadInvoiceFromWeb(supabase, file, opts = {}) {
  const originalName = file && file.name ? file.name : 'document.pdf';
  const safeFileName = buildFileName(originalName);
  const path = `web/${safeFileName}`;
  const { data, error } = await supabase.storage
    .from('invoices')
    .upload(path, file, opts);
  if (error) {
    throw error;
  }
  return { path, originalName, data };
}

module.exports = { buildFileName, uploadInvoiceFromWeb };
