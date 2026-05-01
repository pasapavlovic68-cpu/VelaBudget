export const navItems = [
  { label: 'Главная', icon: 'home', active: true },
  { label: 'История', icon: 'clock', active: false },
  { label: 'Аналитика', icon: 'bars', active: false },
  { label: 'Настройки', icon: 'settings', active: false },
] as const;

export const quickAdd = {
  incomeCategory: 'Зарплата',
  incomeAllocations: [
    { label: 'Обязательное', icon: 'home' },
    { label: 'Стиль жизни', icon: 'cup' },
    { label: 'Капитал', icon: 'trend' },
  ],
  keypad: ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'backspace'],
} as const;

export const expenseCategories: Record<'needs' | 'lifestyle' | 'capital', string[]> = {
  needs: ['Еда', 'Аренда', 'Коммунальные', 'Связь', 'Транспорт', 'Здоровье', 'Документы', 'Другое'],
  lifestyle: ['Кафе', 'Одежда', 'Развлечения', 'Подарки', 'Путешествия', 'Красота', 'Подписки', 'Другое'],
  capital: ['Накопления', 'Инвестиции', 'Резерв', 'Долги', 'Обучение', 'Крупная цель', 'Другое'],
};
