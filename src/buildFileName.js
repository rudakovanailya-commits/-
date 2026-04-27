/**
 * Безопасное имя для Supabase Storage: {timestamp}-{base}.{ext}
 * В путь Storage не попадают исходные «Счет», «№», «апреля» и т.д. — только очищенный base.
 * В БД (expenses.file_name) храните исходное имя отдельно.
 */
function buildFileName(originalName) {
  if (!originalName) {
    return `file-${Date.now()}.pdf`;
  }

  const ext = originalName.includes('.')
    ? originalName.split('.').pop()
    : 'pdf';

  let base = originalName
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/\s+/g, '_')
    .replace(/№/g, '')
    .replace(/[^\w\-]/g, '');

  if (!base) {
    base = 'file';
  }

  return `${Date.now()}-${base}.${String(ext).toLowerCase()}`;
}

module.exports = { buildFileName };
