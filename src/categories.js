/**
 * Временные категории/подкатегории — править только здесь.
 * callback: category:{id}, subcategory:{category_id}:{subcategory_id}
 * (у second части subcategory_id уникален внутри parent)
 */

const categories = [
  {
    id: 'materials',
    title: 'Материалы',
    subcategories: [
      { id: 'building', title: 'Строительные материалы' },
      { id: 'office', title: 'Офисные материалы' },
      { id: 'other', title: 'Прочее' }
    ]
  },
  {
    id: 'services',
    title: 'Услуги',
    subcategories: [
      { id: 'accounting', title: 'Бухгалтерские услуги' },
      { id: 'repair', title: 'Ремонтные услуги' },
      { id: 'other', title: 'Прочее' }
    ]
  },
  {
    id: 'transport',
    title: 'Транспорт',
    subcategories: [
      { id: 'delivery', title: 'Доставка' },
      { id: 'fuel', title: 'Топливо' },
      { id: 'other', title: 'Прочее' }
    ]
  },
  {
    id: 'rent',
    title: 'Аренда',
    subcategories: [
      { id: 'office', title: 'Офис' },
      { id: 'equipment', title: 'Оборудование' },
      { id: 'other', title: 'Прочее' }
    ]
  },
  {
    id: 'other',
    title: 'Прочее',
    subcategories: [{ id: 'other', title: 'Прочее' }]
  }
];

const BY_CATEGORY = new Map(categories.map((c) => [c.id, c]));

function getCategoryById(id) {
  return BY_CATEGORY.get(id) || null;
}

/**
 * @param {string} categoryId
 * @param {string} subcategoryId локальный id подкатегории
 */
function getSubcategoryByIds(categoryId, subcategoryId) {
  const category = getCategoryById(categoryId);
  if (!category) {
    return null;
  }
  const subcategory = category.subcategories.find((s) => s.id === subcategoryId);
  if (!subcategory) {
    return null;
  }
  return { category, subcategory };
}

/**
 * @deprecated оставлено для обратной совместимости импорта; используйте categories
 */
const CATEGORIES = categories.map((c) => ({ id: c.id, label: c.title }));

/**
 * @deprecated
 */
function getLabelById(id) {
  const c = getCategoryById(id);
  return c ? c.title : id;
}

module.exports = {
  categories,
  getCategoryById,
  getSubcategoryByIds,
  CATEGORIES,
  getLabelById
};
