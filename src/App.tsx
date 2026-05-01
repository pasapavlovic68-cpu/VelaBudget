import { expenseCategories, navItems, quickAdd } from './data/mockData';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, authPersistenceReady, db, googleProvider, isFirebaseConfigured } from './firebase';

const DEFAULT_USD_RATE_VND = 25_300;
const STORAGE_KEY = 'velaBudget:v1';

type BucketKey = 'needs' | 'lifestyle' | 'capital';
type Screen = 'home' | 'history' | 'analytics' | 'settings';
type AuthMode = 'login' | 'register';
type HistoryPeriod = 'day' | 'week' | 'month';
type CurrencyCode = 'VND' | 'USD' | 'EUR' | 'THB';
type CloudStatus = 'local' | 'loading' | 'synced' | 'saving' | 'error';
type ExchangeRateStatus = 'idle' | 'loading' | 'success' | 'error';
type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type CurrencySettings = {
  primary: CurrencyCode;
  secondary: CurrencyCode;
};

type BudgetRule = Record<BucketKey, number>;

type Transaction = {
  id: string;
  type: 'income' | 'expense' | 'transfer';
  amountVnd: number;
  usdApprox: number;
  bucket?: BucketKey;
  walletId?: string;
  category: string;
  budgetRule?: BudgetRule;
  incomeDistributionMode?: 'auto' | 'manual';
  incomeTargetBucket?: BucketKey;
  incomeTargetBuckets?: BucketKey[];
  comment?: string;
  createdAt: string;
  fromWalletId?: string;
  toWalletId?: string;
  transferRateVnd?: number;
  transferAmountUsd?: number;
};

type MandatoryPayment = {
  id: string;
  name: string;
  amountVnd: number;
  dueDay: number;
  isActive: boolean;
  createdAt: string;
};

type Wallet = {
  id: string;
  name: string;
  isDefault?: boolean;
  openingBalanceVnd?: number;
  isArchived?: boolean;
  createdAt: string;
};

type SavedState = {
  monthlyState: MonthlyState;
  transactions: Transaction[];
  usdRateVnd: number;
  usdRateUpdatedAt?: string | null;
  customCategories: Record<BucketKey, string[]>;
  hiddenCategories: Record<BucketKey, string[]>;
  categoryUsage: Record<BucketKey, Record<string, number>>;
  mandatoryPayments: MandatoryPayment[];
  currencySettings: CurrencySettings;
  budgetRule: BudgetRule;
  activeMonth: string;
  wallets: Wallet[];
  defaultWalletId: string;
  dailySpendDays: number;
  weekStartDay: WeekStartDay;
};

type BucketState = {
  label: string;
  percent: number;
  allocatedVnd: number;
  spentVnd: number;
  icon: IconName;
};

type MonthlyState = {
  totalIncomeVnd: number;
  buckets: Record<BucketKey, BucketState>;
};

const initialMonthlyState: MonthlyState = {
  totalIncomeVnd: 0,
  buckets: {
    needs: {
      label: 'Обязательное',
      percent: 50,
      allocatedVnd: 0,
      spentVnd: 0,
      icon: 'home',
    },
    lifestyle: {
      label: 'Стиль жизни',
      percent: 30,
      allocatedVnd: 0,
      spentVnd: 0,
      icon: 'cup',
    },
    capital: {
      label: 'Капитал',
      percent: 20,
      allocatedVnd: 0,
      spentVnd: 0,
      icon: 'trend',
    },
  },
};

const DEFAULT_CURRENCY_SETTINGS: CurrencySettings = {
  primary: 'VND',
  secondary: 'USD',
};

const DEFAULT_BUDGET_RULE: BudgetRule = {
  needs: 50,
  lifestyle: 30,
  capital: 20,
};

const DEFAULT_DAILY_SPEND_DAYS = 30;
const DAILY_SPEND_DAY_OPTIONS = [7, 14, 30] as const;
const DEFAULT_WEEK_START_DAY: WeekStartDay = 1;
const WEEK_START_DAY_OPTIONS: { value: WeekStartDay; label: string }[] = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
];
const DEFAULT_WALLET_ID = 'dongi';
const DEFAULT_WALLET_CREATED_AT = '2026-01-01T00:00:00.000Z';
const DEFAULT_WALLETS: Wallet[] = [
  {
    id: DEFAULT_WALLET_ID,
    name: 'Донги',
    isDefault: true,
    openingBalanceVnd: 0,
    isArchived: false,
    createdAt: DEFAULT_WALLET_CREATED_AT,
  },
  {
    id: 'crypto',
    name: 'Крипта',
    isDefault: false,
    openingBalanceVnd: 0,
    isArchived: false,
    createdAt: DEFAULT_WALLET_CREATED_AT,
  },
];

const currencyOptions: { code: CurrencyCode; symbol: string; name: string }[] = [
  { code: 'VND', symbol: '₫', name: 'Vietnamese Dong' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht' },
];

const currencyOptionByCode: Record<CurrencyCode, (typeof currencyOptions)[number]> = {
  VND: currencyOptions[0],
  USD: currencyOptions[1],
  EUR: currencyOptions[2],
  THB: currencyOptions[3],
};

function createEmptyMonthlyState(): MonthlyState {
  return {
    totalIncomeVnd: 0,
    buckets: {
      needs: { ...initialMonthlyState.buckets.needs, allocatedVnd: 0, spentVnd: 0 },
      lifestyle: { ...initialMonthlyState.buckets.lifestyle, allocatedVnd: 0, spentVnd: 0 },
      capital: { ...initialMonthlyState.buckets.capital, allocatedVnd: 0, spentVnd: 0 },
    },
  };
}

function createEmptyCustomCategories(): Record<BucketKey, string[]> {
  return {
    needs: [],
    lifestyle: [],
    capital: [],
  };
}

function createEmptyHiddenCategories(): Record<BucketKey, string[]> {
  return {
    needs: [],
    lifestyle: [],
    capital: [],
  };
}

function createEmptyCategoryUsage(): Record<BucketKey, Record<string, number>> {
  return {
    needs: {},
    lifestyle: {},
    capital: {},
  };
}

function createDefaultWallets(): Wallet[] {
  return DEFAULT_WALLETS.map((wallet) => ({ ...wallet }));
}

function createCleanSavedState(): SavedState {
  return {
    monthlyState: createEmptyMonthlyState(),
    transactions: [],
    usdRateVnd: DEFAULT_USD_RATE_VND,
    usdRateUpdatedAt: null,
    customCategories: createEmptyCustomCategories(),
    hiddenCategories: createEmptyHiddenCategories(),
    categoryUsage: createEmptyCategoryUsage(),
    mandatoryPayments: [],
    currencySettings: DEFAULT_CURRENCY_SETTINGS,
    budgetRule: DEFAULT_BUDGET_RULE,
    activeMonth: getCurrentMonthValue(),
    wallets: createDefaultWallets(),
    defaultWalletId: DEFAULT_WALLET_ID,
    dailySpendDays: DEFAULT_DAILY_SPEND_DAYS,
    weekStartDay: DEFAULT_WEEK_START_DAY,
  };
}

function createTransactionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const bucketByLabel: Record<string, BucketKey> = {
  Обязательное: 'needs',
  'Стиль жизни': 'lifestyle',
  Капитал: 'capital',
};

const bucketDisplayLabel: Record<BucketKey, string> = {
  needs: 'Обязательное',
  lifestyle: 'Стиль жизни',
  capital: 'Капитал',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCurrencyCode(value: unknown): value is CurrencyCode {
  return value === 'VND' || value === 'USD' || value === 'EUR' || value === 'THB';
}

function getCurrentMonthValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isValidActiveMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    return false;
  }

  const [, month] = value.split('-').map(Number);
  return month >= 1 && month <= 12;
}

function readSavedActiveMonth(value: unknown) {
  return isValidActiveMonth(value) ? value : getCurrentMonthValue();
}

function readSavedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : value;
}

function getRemainingDaysInActiveMonth(activeMonth: string): number {
  const source = isValidActiveMonth(activeMonth) ? activeMonth : getCurrentMonthValue();
  const [year, month] = source.split('-').map(Number);
  const today = new Date();
  const activeMonthIndex = month - 1;
  const daysInActiveMonth = new Date(year, month, 0).getDate();
  const todayMonthValue = getCurrentMonthValue();

  if (source === todayMonthValue) {
    return Math.max(1, daysInActiveMonth - today.getDate() + 1);
  }

  const activeMonthStart = new Date(year, activeMonthIndex, 1);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  if (activeMonthStart > currentMonthStart) {
    return Math.max(1, daysInActiveMonth);
  }

  return 1;
}

function isTransactionInActiveMonth(createdAt: string, activeMonth: string): boolean {
  const source = isValidActiveMonth(activeMonth) ? activeMonth : getCurrentMonthValue();
  const [year, month] = source.split('-').map(Number);
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.getFullYear() === year && date.getMonth() + 1 === month;
}

function readSavedCurrencySettings(value: unknown): CurrencySettings {
  if (!isRecord(value) || !isCurrencyCode(value.primary) || !isCurrencyCode(value.secondary)) {
    return DEFAULT_CURRENCY_SETTINGS;
  }

  return {
    primary: value.primary,
    secondary: value.secondary,
  };
}

function isValidBudgetRule(rule: BudgetRule) {
  return (
    Number.isInteger(rule.needs) &&
    Number.isInteger(rule.lifestyle) &&
    Number.isInteger(rule.capital) &&
    rule.needs >= 0 &&
    rule.needs <= 100 &&
    rule.lifestyle >= 0 &&
    rule.lifestyle <= 100 &&
    rule.capital >= 0 &&
    rule.capital <= 100 &&
    rule.needs + rule.lifestyle + rule.capital === 100
  );
}

function readSavedBudgetRule(value: unknown): BudgetRule {
  if (!isRecord(value)) {
    return DEFAULT_BUDGET_RULE;
  }

  const rule = {
    needs: isFiniteNumber(value.needs) ? value.needs : Number.NaN,
    lifestyle: isFiniteNumber(value.lifestyle) ? value.lifestyle : Number.NaN,
    capital: isFiniteNumber(value.capital) ? value.capital : Number.NaN,
  };

  return isValidBudgetRule(rule) ? rule : DEFAULT_BUDGET_RULE;
}

function readSavedDailySpendDays(value: unknown): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1 || value > 365) {
    return DEFAULT_DAILY_SPEND_DAYS;
  }

  return value;
}

function readSavedWeekStartDay(value: unknown): WeekStartDay {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6
    ? value
    : DEFAULT_WEEK_START_DAY;
}

function readSavedBucket(value: unknown, fallback: BucketState): BucketState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isFiniteNumber(value.allocatedVnd) || !isFiniteNumber(value.spentVnd)) {
    return null;
  }

  return {
    ...fallback,
    allocatedVnd: value.allocatedVnd,
    spentVnd: value.spentVnd,
  };
}

function readSavedMonthlyState(value: unknown): MonthlyState | null {
  if (!isRecord(value) || !isFiniteNumber(value.totalIncomeVnd) || !isRecord(value.buckets)) {
    return null;
  }

  const needs = readSavedBucket(value.buckets.needs, initialMonthlyState.buckets.needs);
  const lifestyle = readSavedBucket(value.buckets.lifestyle, initialMonthlyState.buckets.lifestyle);
  const capital = readSavedBucket(value.buckets.capital, initialMonthlyState.buckets.capital);

  if (!needs || !lifestyle || !capital) {
    return null;
  }

  return {
    totalIncomeVnd: value.totalIncomeVnd,
    buckets: {
      needs,
      lifestyle,
      capital,
    },
  };
}

function readSavedWallets(value: unknown): Wallet[] {
  if (!Array.isArray(value)) {
    return createDefaultWallets();
  }

  const seenIds = new Set<string>();
  const wallets: Wallet[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const openingBalanceVnd = item.openingBalanceVnd;

    if (
      !id ||
      !name ||
      seenIds.has(id) ||
      typeof item.createdAt !== 'string' ||
      (item.isDefault !== undefined && typeof item.isDefault !== 'boolean') ||
      (openingBalanceVnd !== undefined && !isFiniteNumber(openingBalanceVnd)) ||
      (item.isArchived !== undefined && typeof item.isArchived !== 'boolean')
    ) {
      continue;
    }

    seenIds.add(id);
    wallets.push({
      id,
      name,
      isDefault: item.isDefault === true,
      openingBalanceVnd: isFiniteNumber(openingBalanceVnd) ? openingBalanceVnd : 0,
      isArchived: item.isArchived === true,
      createdAt: item.createdAt,
    });
  }

  for (const def of DEFAULT_WALLETS) {
    if (!wallets.some((w) => w.id === def.id)) {
      wallets.push({ ...def });
    }
  }

  return wallets;
}

function readSavedDefaultWalletId(value: unknown, wallets: Wallet[]): string {
  if (typeof value === 'string' && wallets.some((wallet) => wallet.id === value)) {
    return value;
  }

  return DEFAULT_WALLET_ID;
}

function readSavedTransactions(value: unknown, defaultWalletId = DEFAULT_WALLET_ID, walletIds = new Set<string>([DEFAULT_WALLET_ID])): Transaction[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const transactions = value.filter((item): item is Transaction => {
    if (!isRecord(item)) {
      return false;
    }

    const hasValidType = item.type === 'income' || item.type === 'expense' || item.type === 'transfer';
    const hasValidBucket =
      item.bucket === undefined || item.bucket === 'needs' || item.bucket === 'lifestyle' || item.bucket === 'capital';

    return (
      typeof item.id === 'string' &&
      hasValidType &&
      isFiniteNumber(item.amountVnd) &&
      typeof item.category === 'string' &&
      typeof item.createdAt === 'string' &&
      hasValidBucket
    );
  });

  return transactions.map((transaction) => ({
    ...transaction,
    usdApprox: isFiniteNumber(transaction.usdApprox) ? transaction.usdApprox : Math.round(transaction.amountVnd / DEFAULT_USD_RATE_VND),
    walletId:
      typeof transaction.walletId === 'string' && walletIds.has(transaction.walletId)
        ? transaction.walletId
        : defaultWalletId,
    budgetRule: transaction.type === 'income' ? readSavedBudgetRule(transaction.budgetRule) : undefined,
    incomeDistributionMode:
      transaction.type === 'income' && transaction.incomeDistributionMode === 'manual' ? 'manual' : 'auto',
    incomeTargetBucket:
      transaction.type === 'income' &&
      transaction.incomeDistributionMode === 'manual' &&
      (transaction.incomeTargetBucket === 'needs' ||
        transaction.incomeTargetBucket === 'lifestyle' ||
        transaction.incomeTargetBucket === 'capital')
        ? transaction.incomeTargetBucket
        : undefined,
    incomeTargetBuckets:
      transaction.type === 'income' && transaction.incomeDistributionMode === 'manual' && Array.isArray(transaction.incomeTargetBuckets)
        ? transaction.incomeTargetBuckets.filter(
            (bucket, index, buckets): bucket is BucketKey =>
              (bucket === 'needs' || bucket === 'lifestyle' || bucket === 'capital') && buckets.indexOf(bucket) === index,
          )
        : undefined,
  }));
}

function readSavedMandatoryPayments(value: unknown): MandatoryPayment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const payments: MandatoryPayment[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const amountVnd = item.amountVnd;
    const dueDay = item.dueDay;

    if (
      typeof item.id !== 'string' ||
      !name ||
      !isFiniteNumber(amountVnd) ||
      amountVnd < 0 ||
      !Number.isInteger(dueDay) ||
      typeof dueDay !== 'number' ||
      dueDay < 1 ||
      dueDay > 31 ||
      typeof item.isActive !== 'boolean' ||
      typeof item.createdAt !== 'string'
    ) {
      continue;
    }

    payments.push({
      id: item.id,
      name,
      amountVnd,
      dueDay,
      isActive: item.isActive,
      createdAt: item.createdAt,
    });
  }

  return payments;
}

const EMPTY_CUSTOM_CATEGORIES: Record<BucketKey, string[]> = {
  needs: [],
  lifestyle: [],
  capital: [],
};

const EMPTY_HIDDEN_CATEGORIES: Record<BucketKey, string[]> = {
  needs: [],
  lifestyle: [],
  capital: [],
};

function readSavedCategoryLists(value: unknown, fallback: Record<BucketKey, string[]>): Record<BucketKey, string[]> {
  if (!isRecord(value)) {
    return fallback;
  }

  const readBucket = (bucket: unknown): string[] => {
    if (!Array.isArray(bucket)) {
      return [];
    }
    return bucket.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  };

  return {
    needs: readBucket(value.needs),
    lifestyle: readBucket(value.lifestyle),
    capital: readBucket(value.capital),
  };
}

function readSavedCustomCategories(value: unknown): Record<BucketKey, string[]> {
  return readSavedCategoryLists(value, EMPTY_CUSTOM_CATEGORIES);
}

function readSavedHiddenCategories(value: unknown): Record<BucketKey, string[]> {
  return readSavedCategoryLists(value, EMPTY_HIDDEN_CATEGORIES);
}

function getMergedExpenseCategories(
  defaults: Record<BucketKey, string[]>,
  custom: Record<BucketKey, string[]>,
  hidden: Record<BucketKey, string[]>,
): Record<BucketKey, string[]> {
  const mergeBucket = (presets: string[], extras: string[], hiddenItems: string[]): string[] => {
    const seen = new Set<string>();
    const hiddenSet = new Set(hiddenItems.map((item) => item.trim().toLowerCase()));
    const result: string[] = [];
    for (const cat of [...presets, ...extras]) {
      const trimmed = cat.trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !hiddenSet.has(key) && !seen.has(key)) {
        seen.add(key);
        result.push(trimmed);
      }
    }
    return result.length > 0 || hiddenSet.has('другое') ? result : ['Другое'];
  };

  return {
    needs: mergeBucket(defaults.needs, custom.needs, hidden.needs),
    lifestyle: mergeBucket(defaults.lifestyle, custom.lifestyle, hidden.lifestyle),
    capital: mergeBucket(defaults.capital, custom.capital, hidden.capital),
  };
}

function getAllExpenseCategoryNames(
  defaults: Record<BucketKey, string[]>,
  custom: Record<BucketKey, string[]>,
  hidden: Record<BucketKey, string[]>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const bucketKey of ['needs', 'lifestyle', 'capital'] as BucketKey[]) {
    for (const cat of [...defaults[bucketKey], ...custom[bucketKey], ...hidden[bucketKey]]) {
      const trimmed = cat.trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !seen.has(key)) {
        seen.add(key);
        result.push(trimmed);
      }
    }
  }
  return result;
}

const EMPTY_CATEGORY_USAGE: Record<BucketKey, Record<string, number>> = {
  needs: {},
  lifestyle: {},
  capital: {},
};

function readSavedCategoryUsage(value: unknown): Record<BucketKey, Record<string, number>> {
  if (!isRecord(value)) {
    return EMPTY_CATEGORY_USAGE;
  }

  const readBucketUsage = (bucket: unknown): Record<string, number> => {
    if (!isRecord(bucket)) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(bucket)) {
      if (typeof key === 'string' && isFiniteNumber(val) && val >= 0) {
        result[key] = val;
      }
    }
    return result;
  };

  return {
    needs: readBucketUsage(value.needs),
    lifestyle: readBucketUsage(value.lifestyle),
    capital: readBucketUsage(value.capital),
  };
}

function buildCategoryUsageFromTransactions(transactions: Transaction[]): Record<BucketKey, Record<string, number>> {
  return transactions.reduce<Record<BucketKey, Record<string, number>>>((usage, transaction) => {
    if (transaction.type !== 'expense' || !transaction.bucket) {
      return usage;
    }

    const category = transaction.category.trim();
    if (!category) {
      return usage;
    }

    usage[transaction.bucket][category] = (usage[transaction.bucket][category] ?? 0) + 1;
    return usage;
  }, createEmptyCategoryUsage());
}

function isValidSavedState(value: unknown): value is SavedState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    readSavedMonthlyState(value.monthlyState) !== null &&
    readSavedTransactions(value.transactions) !== null &&
    isFiniteNumber(value.usdRateVnd) &&
    value.usdRateVnd > 0
  );
}

function readSavedState(value: unknown): SavedState | null {
  if (!isValidSavedState(value)) {
    return null;
  }

  const wallets = readSavedWallets(value.wallets);
  const defaultWalletId = readSavedDefaultWalletId(value.defaultWalletId, wallets);
  const walletIds = new Set(wallets.map((wallet) => wallet.id));
  const transactions = readSavedTransactions(value.transactions, defaultWalletId, walletIds) ?? [];
  const activeMonth = readSavedActiveMonth(value.activeMonth);

  return {
    monthlyState: rebuildMonthlyStateFromTransactions(transactions, activeMonth),
    transactions,
    usdRateVnd: value.usdRateVnd,
    usdRateUpdatedAt: readSavedTimestamp(value.usdRateUpdatedAt),
    customCategories: readSavedCustomCategories(value.customCategories),
    hiddenCategories: readSavedHiddenCategories(value.hiddenCategories),
    categoryUsage: buildCategoryUsageFromTransactions(transactions),
    mandatoryPayments: readSavedMandatoryPayments(value.mandatoryPayments),
    currencySettings: readSavedCurrencySettings(value.currencySettings),
    budgetRule: readSavedBudgetRule(value.budgetRule),
    activeMonth,
    wallets,
    defaultWalletId,
    dailySpendDays: readSavedDailySpendDays(value.dailySpendDays),
    weekStartDay: readSavedWeekStartDay(value.weekStartDay),
  };
}

function readBackupPayload(value: unknown): SavedState | null {
  const rawData = isRecord(value) && value.app === 'VelaBudget' && isRecord(value.data) ? value.data : value;
  return readSavedState(rawData);
}

function loadSavedState(): SavedState {
  if (typeof window === 'undefined') {
    return {
      monthlyState: createEmptyMonthlyState(),
      transactions: [],
      usdRateVnd: DEFAULT_USD_RATE_VND,
      usdRateUpdatedAt: null,
      customCategories: EMPTY_CUSTOM_CATEGORIES,
      hiddenCategories: EMPTY_HIDDEN_CATEGORIES,
      categoryUsage: EMPTY_CATEGORY_USAGE,
      mandatoryPayments: [],
      currencySettings: DEFAULT_CURRENCY_SETTINGS,
      budgetRule: DEFAULT_BUDGET_RULE,
      activeMonth: getCurrentMonthValue(),
      wallets: createDefaultWallets(),
      defaultWalletId: DEFAULT_WALLET_ID,
      dailySpendDays: DEFAULT_DAILY_SPEND_DAYS,
      weekStartDay: DEFAULT_WEEK_START_DAY,
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return {
        monthlyState: createEmptyMonthlyState(),
        transactions: [],
        usdRateVnd: DEFAULT_USD_RATE_VND,
        usdRateUpdatedAt: null,
        customCategories: EMPTY_CUSTOM_CATEGORIES,
        hiddenCategories: EMPTY_HIDDEN_CATEGORIES,
        categoryUsage: EMPTY_CATEGORY_USAGE,
        mandatoryPayments: [],
        currencySettings: DEFAULT_CURRENCY_SETTINGS,
        budgetRule: DEFAULT_BUDGET_RULE,
        activeMonth: getCurrentMonthValue(),
        wallets: createDefaultWallets(),
        defaultWalletId: DEFAULT_WALLET_ID,
        dailySpendDays: DEFAULT_DAILY_SPEND_DAYS,
        weekStartDay: DEFAULT_WEEK_START_DAY,
      };
    }

    const parsed = JSON.parse(raw);
    const savedState = readSavedState(parsed);

    if (!savedState) {
      return {
        monthlyState: createEmptyMonthlyState(),
        transactions: [],
        usdRateVnd: DEFAULT_USD_RATE_VND,
        usdRateUpdatedAt: null,
        customCategories: EMPTY_CUSTOM_CATEGORIES,
        hiddenCategories: EMPTY_HIDDEN_CATEGORIES,
        categoryUsage: EMPTY_CATEGORY_USAGE,
        mandatoryPayments: [],
        currencySettings: DEFAULT_CURRENCY_SETTINGS,
        budgetRule: DEFAULT_BUDGET_RULE,
        activeMonth: getCurrentMonthValue(),
        wallets: createDefaultWallets(),
        defaultWalletId: DEFAULT_WALLET_ID,
        dailySpendDays: DEFAULT_DAILY_SPEND_DAYS,
        weekStartDay: DEFAULT_WEEK_START_DAY,
      };
    }

    return savedState;
  } catch {
    return {
      monthlyState: createEmptyMonthlyState(),
      transactions: [],
      usdRateVnd: DEFAULT_USD_RATE_VND,
      usdRateUpdatedAt: null,
      customCategories: EMPTY_CUSTOM_CATEGORIES,
      hiddenCategories: EMPTY_HIDDEN_CATEGORIES,
      categoryUsage: EMPTY_CATEGORY_USAGE,
      mandatoryPayments: [],
      currencySettings: DEFAULT_CURRENCY_SETTINGS,
      budgetRule: DEFAULT_BUDGET_RULE,
      activeMonth: getCurrentMonthValue(),
      wallets: createDefaultWallets(),
      defaultWalletId: DEFAULT_WALLET_ID,
      dailySpendDays: DEFAULT_DAILY_SPEND_DAYS,
      weekStartDay: DEFAULT_WEEK_START_DAY,
    };
  }
}

function saveState(state: SavedState) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort; the app should keep working if storage is unavailable.
  }
}

async function fetchUsdVndRate(): Promise<number> {
  const response = await fetch('https://open.er-api.com/v6/latest/USD');

  if (!response.ok) {
    throw new Error('Не удалось получить курс USD');
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload)) {
    throw new Error('Сервис курса вернул неверный ответ');
  }

  const result = payload.result;
  const rates = payload.rates;
  const vndRate = isRecord(rates) ? rates.VND : undefined;

  if (result !== 'success' || !isFiniteNumber(vndRate) || vndRate <= 0) {
    throw new Error('Курс VND недоступен');
  }

  return Math.round(vndRate);
}

function isTimestampToday(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function formatExchangeRateDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatVnd(value: number) {
  const sign = value < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(value))} ₫`;
}

function formatUsdFromVnd(valueVnd: number, usdRateVnd: number) {
  const safeRate = usdRateVnd > 0 ? usdRateVnd : DEFAULT_USD_RATE_VND;
  const value = Math.abs(valueVnd / safeRate);
  const rounded = value >= 10_000 ? Math.round(value / 100) * 100 : Math.round(value / 10) * 10;
  const sign = valueVnd < 0 ? '-' : '';
  return `≈ ${sign}${formatNumber(rounded)} $`;
}

function formatUsdAmount(valueUsd: number) {
  const sign = valueUsd < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(valueUsd))} $`;
}

function formatApproxVnd(valueVnd: number) {
  return `≈ ${formatVnd(valueVnd)}`;
}

function MoneyStack({
  amountVnd,
  usdRateVnd,
  className = '',
  primaryClassName = '',
  prefix = '',
}: {
  amountVnd: number;
  usdRateVnd: number;
  className?: string;
  primaryClassName?: string;
  prefix?: string;
}) {
  return (
    <span className={`money-stack${className ? ` ${className}` : ''}`}>
      <strong className={`money${primaryClassName ? ` ${primaryClassName}` : ''}`}>
        {prefix}
        {formatVnd(amountVnd)}
      </strong>
      <em className="money-secondary">{formatUsdFromVnd(amountVnd, usdRateVnd)}</em>
    </span>
  );
}

function getAmountSuggestions(rawDigits: string) {
  if (!rawDigits) {
    return [];
  }

  const base = Number(rawDigits);

  if (!Number.isFinite(base) || base <= 0) {
    return [];
  }

  return [base * 1_000, base * 100_000, base * 1_000_000];
}

function formatTransactionDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatActiveMonth(value: string) {
  const fallback = getCurrentMonthValue();
  const source = isValidActiveMonth(value) ? value : fallback;
  const [year, month] = source.split('-').map(Number);
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, 1));

  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function formatDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayInputValue() {
  return formatDateInputValue(new Date());
}

function getDefaultQuickAddDate(activeMonth: string): string {
  if (!isValidActiveMonth(activeMonth)) {
    return getTodayInputValue();
  }

  const today = getTodayInputValue();
  return today.startsWith(`${activeMonth}-`) ? today : `${activeMonth}-01`;
}

function getYesterdayInputValue() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateInputValue(date);
}

function dateInputValueToIso(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return new Date().toISOString();
  }
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

function isoToDateInputValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return getTodayInputValue();
  }
  return formatDateInputValue(date);
}

function isToday(value: string) {
  const date = new Date(value);
  const today = new Date();

  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function isWithinLastDays(value: string, days: number) {
  const time = new Date(value).getTime();
  const start = Date.now() - days * 24 * 60 * 60 * 1000;

  return time >= start;
}

function filterTransactions(transactions: Transaction[], period: HistoryPeriod, activeMonth: string) {
  return transactions.filter((transaction) => {
    if (period === 'day') {
      return isToday(transaction.createdAt);
    }

    if (period === 'week') {
      return isWithinLastDays(transaction.createdAt, 7);
    }

    return isTransactionInActiveMonth(transaction.createdAt, activeMonth);
  });
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function getIncomeAllocation(amountVnd: number, budgetRule: BudgetRule) {
  const needs = Math.round((amountVnd * budgetRule.needs) / 100);
  const lifestyle = Math.round((amountVnd * budgetRule.lifestyle) / 100);
  return {
    needs,
    lifestyle,
    capital: amountVnd - needs - lifestyle,
  };
}

function isBucketKey(value: unknown): value is BucketKey {
  return value === 'needs' || value === 'lifestyle' || value === 'capital';
}

function getIncomeTargetBuckets(transaction: Transaction): BucketKey[] {
  if (transaction.incomeDistributionMode !== 'manual') {
    return [];
  }

  const targets = Array.isArray(transaction.incomeTargetBuckets)
    ? transaction.incomeTargetBuckets.filter((bucket, index, buckets): bucket is BucketKey => isBucketKey(bucket) && buckets.indexOf(bucket) === index)
    : [];

  if (targets.length > 0) {
    return targets;
  }

  return isBucketKey(transaction.incomeTargetBucket) ? [transaction.incomeTargetBucket] : ['needs'];
}

function splitAmountAcrossBuckets(amountVnd: number, targets: BucketKey[]): Record<BucketKey, number> {
  const allocation: Record<BucketKey, number> = { needs: 0, lifestyle: 0, capital: 0 };
  const validTargets: BucketKey[] = targets.length > 0 ? targets : ['needs'];
  const baseAmount = Math.floor(amountVnd / validTargets.length);
  let remainder = amountVnd - baseAmount * validTargets.length;

  for (const target of validTargets) {
    allocation[target] = baseAmount + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
  }

  return allocation;
}

function getTransactionIncomeAllocation(transaction: Transaction): Record<BucketKey, number> {
  if (transaction.incomeDistributionMode === 'manual') {
    return splitAmountAcrossBuckets(transaction.amountVnd, getIncomeTargetBuckets(transaction));
  }

  return getIncomeAllocation(transaction.amountVnd, transaction.budgetRule ?? DEFAULT_BUDGET_RULE);
}

function getDailySpendDivisor(dailySpendDays: number, weekStartDay: WeekStartDay, date = new Date()): number {
  const safeDays = readSavedDailySpendDays(dailySpendDays);

  if (safeDays !== 7) {
    return safeDays;
  }

  const safeWeekStartDay = readSavedWeekStartDay(weekStartDay);
  const elapsedDays = (date.getDay() - safeWeekStartDay + 7) % 7;
  return Math.min(Math.max(7 - elapsedDays, 1), 7);
}

function deriveCryptoMonthlyIncomeUsd(
  transactions: Transaction[],
  activeMonth: string,
  usdRateVnd: number,
): number {
  const safeRate = usdRateVnd > 0 ? usdRateVnd : DEFAULT_USD_RATE_VND;
  const totalVnd = transactions
    .filter(
      (t) =>
        t.type === 'income' &&
        t.walletId === 'crypto' &&
        isTransactionInActiveMonth(t.createdAt, activeMonth),
    )
    .reduce((sum, t) => sum + t.amountVnd, 0);
  return Math.round(totalVnd / safeRate);
}

function deriveHomeData(
  monthlyState: MonthlyState,
  usdRateVnd: number,
  budgetRule: BudgetRule,
  activeMonth: string,
  dailySpendDays: number,
  weekStartDay: WeekStartDay,
  dongiBalanceVnd: number,
  cryptoIncomeUsd: number,
) {
  const buckets = Object.entries(monthlyState.buckets).map(([key, bucket]) => {
    const remainingVnd = bucket.allocatedVnd - bucket.spentVnd;
    const bucketKey = key as BucketKey;

    return {
      key,
      percent: `${budgetRule[bucketKey]}%`,
      label: bucket.label,
      allocated: formatVnd(bucket.allocatedVnd),
      allocatedVnd: bucket.allocatedVnd,
      spent: formatVnd(bucket.spentVnd),
      spentVnd: bucket.spentVnd,
      left: formatVnd(remainingVnd),
      leftVnd: remainingVnd,
      progress: clampProgress((bucket.spentVnd / bucket.allocatedVnd) * 100),
      icon: bucket.icon,
    };
  });

  const spendableAllocatedVnd = monthlyState.buckets.needs.allocatedVnd + monthlyState.buckets.lifestyle.allocatedVnd;
  const spendableRemainingVnd =
    monthlyState.buckets.needs.allocatedVnd -
    monthlyState.buckets.needs.spentVnd +
    monthlyState.buckets.lifestyle.allocatedVnd -
    monthlyState.buckets.lifestyle.spentVnd;
  const dailyDivisor = getDailySpendDivisor(dailySpendDays, weekStartDay);
  const dailyAvailableVnd = Math.max(0, Math.round(spendableRemainingVnd / dailyDivisor));
  const dailyTotalVnd = Math.round(spendableAllocatedVnd / dailyDivisor);

  return {
    summary: {
      month: formatActiveMonth(activeMonth),
      subtitle: 'Сводка месяца',
      balance: formatVnd(dongiBalanceVnd),
      balanceSecondary: formatUsdFromVnd(dongiBalanceVnd, usdRateVnd),
      income: formatVnd(monthlyState.totalIncomeVnd),
      incomeSecondary: formatUsdFromVnd(monthlyState.totalIncomeVnd, usdRateVnd),
      cryptoIncomeUsd,
      dailyAvailable: formatVnd(dailyAvailableVnd),
      dailyAvailableVnd,
      dailyTotal: formatVnd(dailyTotalVnd),
      dailyTotalVnd,
      dailyProgress: clampProgress((dailyAvailableVnd / dailyTotalVnd) * 100),
    },
    allocations: buckets,
  };
}

function deriveMandatoryProgress(
  mandatoryPayments: MandatoryPayment[],
  collectedVnd: number,
  transactions: Transaction[],
  activeMonth: string,
) {
  const active = mandatoryPayments.filter((p) => p.isActive);
  const totalVnd = active.reduce((sum, p) => sum + p.amountVnd, 0);
  const remainingVnd = Math.max(totalVnd - collectedVnd, 0);
  const progressPercent = totalVnd > 0 ? Math.min((collectedVnd / totalVnd) * 100, 100) : 0;
  const today = new Date().getDate();
  const upcoming = active.filter((p) => p.dueDay >= today);
  const nearest =
    upcoming.length > 0
      ? upcoming.reduce((a, b) => (a.dueDay <= b.dueDay ? a : b))
      : active.length > 0
        ? active.reduce((a, b) => (a.dueDay <= b.dueDay ? a : b))
        : null;

  const paymentStatuses = active.map((payment) => {
    const paidAmountVnd = transactions
      .filter(
        (t) =>
          t.type === 'expense' &&
          t.bucket === 'needs' &&
          t.category.toLowerCase() === payment.name.toLowerCase() &&
          isTransactionInActiveMonth(t.createdAt, activeMonth),
      )
      .reduce((sum, t) => sum + t.amountVnd, 0);

    const status: 'paid' | 'partial' | 'waiting' =
      paidAmountVnd >= payment.amountVnd ? 'paid' : paidAmountVnd > 0 ? 'partial' : 'waiting';

    return { payment, paidAmountVnd, status };
  });

  const paidCount = paymentStatuses.filter((s) => s.status === 'paid').length;

  return {
    hasActive: active.length > 0,
    totalVnd,
    collectedVnd,
    remainingVnd,
    progressPercent,
    isFunded: totalVnd > 0 && remainingVnd === 0,
    nearest,
    paymentStatuses,
    paidCount,
    activeCount: active.length,
  };
}

function shouldAffectMonthlyBudget(transaction: Transaction): boolean {
  if (transaction.type === 'transfer') return false;
  return !(transaction.type === 'income' && transaction.walletId === 'crypto');
}

function applyTransactionEffect(monthlyState: MonthlyState, transaction: Transaction): MonthlyState {
  if (!shouldAffectMonthlyBudget(transaction)) {
    return monthlyState;
  }

  if (transaction.type === 'income') {
    const allocation = getTransactionIncomeAllocation(transaction);

    return {
      totalIncomeVnd: monthlyState.totalIncomeVnd + transaction.amountVnd,
      buckets: {
        needs: {
          ...monthlyState.buckets.needs,
          allocatedVnd: monthlyState.buckets.needs.allocatedVnd + allocation.needs,
        },
        lifestyle: {
          ...monthlyState.buckets.lifestyle,
          allocatedVnd: monthlyState.buckets.lifestyle.allocatedVnd + allocation.lifestyle,
        },
        capital: {
          ...monthlyState.buckets.capital,
          allocatedVnd: monthlyState.buckets.capital.allocatedVnd + allocation.capital,
        },
      },
    };
  }

  const bucketKey = transaction.bucket ?? 'lifestyle';

  return {
    ...monthlyState,
    buckets: {
      ...monthlyState.buckets,
      [bucketKey]: {
        ...monthlyState.buckets[bucketKey],
        spentVnd: monthlyState.buckets[bucketKey].spentVnd + transaction.amountVnd,
      },
    },
  };
}

function rebuildMonthlyStateFromTransactions(transactions: Transaction[], activeMonth: string): MonthlyState {
  return transactions.reduce<MonthlyState>((monthlyState, transaction) => {
    if (!isTransactionInActiveMonth(transaction.createdAt, activeMonth)) {
      return monthlyState;
    }

    if (transaction.type === 'expense' && !transaction.bucket) {
      return monthlyState;
    }

    return applyTransactionEffect(monthlyState, transaction);
  }, createEmptyMonthlyState());
}

function reverseTransactionEffect(monthlyState: MonthlyState, transaction: Transaction): MonthlyState {
  if (!shouldAffectMonthlyBudget(transaction)) {
    return monthlyState;
  }

  if (transaction.type === 'income') {
    const allocation = getTransactionIncomeAllocation(transaction);

    return {
      totalIncomeVnd: monthlyState.totalIncomeVnd - transaction.amountVnd,
      buckets: {
        needs: {
          ...monthlyState.buckets.needs,
          allocatedVnd: monthlyState.buckets.needs.allocatedVnd - allocation.needs,
        },
        lifestyle: {
          ...monthlyState.buckets.lifestyle,
          allocatedVnd: monthlyState.buckets.lifestyle.allocatedVnd - allocation.lifestyle,
        },
        capital: {
          ...monthlyState.buckets.capital,
          allocatedVnd: monthlyState.buckets.capital.allocatedVnd - allocation.capital,
        },
      },
    };
  }

  const bucketKey = transaction.bucket ?? 'lifestyle';

  return {
    ...monthlyState,
    buckets: {
      ...monthlyState.buckets,
      [bucketKey]: {
        ...monthlyState.buckets[bucketKey],
        spentVnd: monthlyState.buckets[bucketKey].spentVnd - transaction.amountVnd,
      },
    },
  };
}

type IconName =
  | 'home'
  | 'cup'
  | 'trend'
  | 'chevron'
  | 'info'
  | 'calendar'
  | 'clock'
  | 'bars'
  | 'settings'
  | 'plus'
  | 'arrowLeft'
  | 'help'
  | 'backspace'
  | 'tag'
  | 'message'
  | 'trash'
  | 'edit'
  | 'mail'
  | 'lock'
  | 'user';

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const common = {
    className: `icon ${className}`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  const paths: Record<IconName, ReactElement> = {
    home: (
      <>
        <path d="M3.2 11.3 12 4l8.8 7.3" />
        <path d="M5.4 10.4v9h4.4v-5.3h4.4v5.3h4.4v-9" />
      </>
    ),
    cup: (
      <>
        <path d="M6 9h9.7v4.1a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V9Z" />
        <path d="M15.7 10.2h1.2a2.1 2.1 0 0 1 0 4.2h-1.2" />
        <path d="M7.4 20h8.8" />
        <path d="M9 5.1c-.7.7-.7 1.4 0 2.1" />
        <path d="M13 5.1c-.7.7-.7 1.4 0 2.1" />
      </>
    ),
    trend: (
      <>
        <path d="M4 18v-3.1" />
        <path d="M8.6 18v-6" />
        <path d="M13.2 18v-8.4" />
        <path d="M17.8 18V6.7" />
        <path d="m4.5 11.6 4.7-4.2 3.7 3 5.6-6" />
        <path d="M15.1 4.4h3.4v3.4" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 10.8v5.4" />
        <path d="M12 7.8h.01" />
      </>
    ),
    calendar: (
      <>
        <rect x="4" y="5.5" width="16" height="14" rx="2.6" />
        <path d="M8 3.8v3.5" />
        <path d="M16 3.8v3.5" />
        <path d="M4 10h16" />
        <path d="M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 16.5h.01M12 16.5h.01" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.6V12l3.2 2.3" />
      </>
    ),
    bars: (
      <>
        <path d="M6 19V9" />
        <path d="M12 19V5" />
        <path d="M18 19v-7" />
        <rect x="4" y="9" width="4" height="10" rx="1.2" />
        <rect x="10" y="5" width="4" height="14" rx="1.2" />
        <rect x="16" y="12" width="4" height="7" rx="1.2" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    arrowLeft: (
      <>
        <path d="M19 12H5" />
        <path d="m12 5-7 7 7 7" />
      </>
    ),
    help: (
      <>
        <path d="M9.3 9a3 3 0 1 1 4.9 2.3c-.9.7-1.7 1.2-1.7 2.7" />
        <path d="M12.5 17.4h.01" />
      </>
    ),
    backspace: (
      <>
        <path d="M21 6.8v10.4a2 2 0 0 1-2 2H9.2L3 12l6.2-7.2H19a2 2 0 0 1 2 2Z" />
        <path d="m15.5 9.5-5 5" />
        <path d="m10.5 9.5 5 5" />
      </>
    ),
    tag: (
      <>
        <path d="M20 13.2 12.2 21 3 11.8V4h7.8L20 13.2Z" />
        <path d="M7.8 7.8h.01" />
      </>
    ),
    message: (
      <>
        <path d="M5 5h14v10.5H8.8L5 19V5Z" />
        <path d="M8.5 9h7" />
        <path d="M8.5 12h4.8" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M6.5 7 7.4 20h9.2l.9-13" />
        <path d="M9 7V4.8h6V7" />
      </>
    ),
    edit: (
      <>
        <path d="M4 20h4.5L19 9.5 14.5 5 4 15.5V20Z" />
        <path d="m13.5 6 4.5 4.5" />
      </>
    ),
    mail: (
      <>
        <rect x="4" y="6.5" width="16" height="11" rx="2.4" />
        <path d="m5.2 8 6.8 5.2L18.8 8" />
      </>
    ),
    lock: (
      <>
        <rect x="5.5" y="10.2" width="13" height="9" rx="2.2" />
        <path d="M8.4 10.2V8a3.6 3.6 0 0 1 7.2 0v2.2" />
        <path d="M12 14v2" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8.2" r="3.2" />
        <path d="M5.8 19.2a6.2 6.2 0 0 1 12.4 0" />
      </>
    ),
  };

  return <svg {...common}>{paths[name]}</svg>;
}

type AuthField = 'name' | 'email' | 'password' | 'repeatPassword';
type AuthErrors = Partial<Record<AuthField, string>>;

function AuthScreen({
  mode,
  onModeChange,
  onEnterPreview,
  onGoogleAuth,
  authLoading,
  cloudError,
}: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onEnterPreview: () => void;
  onGoogleAuth: () => Promise<void>;
  authLoading: boolean;
  cloudError: string;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [errors, setErrors] = useState<AuthErrors>({});
  const [googleNote, setGoogleNote] = useState('');
  const isRegister = mode === 'register';

  const resetFeedback = () => {
    setErrors({});
    setGoogleNote('');
  };

  const switchMode = (nextMode: AuthMode) => {
    resetFeedback();
    onModeChange(nextMode);
  };

  const validateAuthForm = (): boolean => {
    const nextErrors: AuthErrors = {};

    if (isRegister && !name.trim()) {
      nextErrors.name = 'Введите имя';
    }

    if (!email.trim()) {
      nextErrors.email = 'Введите email';
    }

    if (!password.trim()) {
      nextErrors.password = 'Введите пароль';
    }

    if (isRegister && password.trim() && repeatPassword !== password) {
      nextErrors.repeatPassword = 'Пароли не совпадают';
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGoogleNote('');

    if (validateAuthForm()) {
      onEnterPreview();
    }
  };

  const handleGoogleAuthClick = async (authMode: AuthMode) => {
    setErrors({});
    setGoogleNote('');
    void authMode;

    try {
      await onGoogleAuth();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось войти через Google';
      setGoogleNote(message);
    }
  };

  return (
    <main className="app-shell auth-shell">
      <div className="phone-surface auth-surface">
        <section className="auth-content" aria-label={isRegister ? 'Регистрация' : 'Вход в аккаунт'}>
          <header className="auth-brand">
            <h1>
              <span>Vela</span>Budget
            </h1>
            <p>{isRegister ? 'Регистрация' : 'Вход в аккаунт'}</p>
          </header>

          <form className="auth-card appear" style={{ '--delay': '80ms' } as CSSProperties} onSubmit={handleSubmit}>
            {isRegister ? (
              <label className="auth-field">
                <span>Имя</span>
                <div className="auth-input-wrap">
                  <Icon name="user" />
                  <input
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      resetFeedback();
                    }}
                    autoComplete="name"
                    inputMode="text"
                  />
                </div>
                {errors.name ? <em>{errors.name}</em> : null}
              </label>
            ) : null}

            <label className="auth-field">
              <span>Email</span>
              <div className="auth-input-wrap">
                <Icon name="mail" />
                <input
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    resetFeedback();
                  }}
                  autoComplete="email"
                  inputMode="email"
                />
              </div>
              {errors.email ? <em>{errors.email}</em> : null}
            </label>

            <label className="auth-field">
              <span>Пароль</span>
              <div className="auth-input-wrap">
                <Icon name="lock" />
                <input
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    resetFeedback();
                  }}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  type="password"
                />
              </div>
              {errors.password ? <em>{errors.password}</em> : null}
            </label>

            {isRegister ? (
              <label className="auth-field">
                <span>Повторите пароль</span>
                <div className="auth-input-wrap">
                  <Icon name="lock" />
                  <input
                    value={repeatPassword}
                    onChange={(event) => {
                      setRepeatPassword(event.target.value);
                      resetFeedback();
                    }}
                    autoComplete="new-password"
                    type="password"
                  />
                </div>
                {errors.repeatPassword ? <em>{errors.repeatPassword}</em> : null}
              </label>
            ) : (
              <button className="auth-forgot" type="button">
                Забыли пароль?
              </button>
            )}

            <button className="auth-primary" type="submit">
              {isRegister ? 'Зарегистрироваться' : 'Войти'}
            </button>

            <div className="auth-divider">
              <span>или</span>
            </div>

            <button
              className="auth-google"
              type="button"
              onClick={() => void handleGoogleAuthClick(mode)}
              disabled={authLoading}
            >
              <span className="auth-google-mark" aria-hidden="true">
                G
              </span>
              {authLoading ? 'Проверяем вход...' : isRegister ? 'Зарегистрироваться через Google' : 'Войти через Google'}
            </button>

            {googleNote || cloudError ? <p className="auth-note">{googleNote || cloudError}</p> : null}

            <p className="auth-switch">
              {isRegister ? 'Уже есть аккаунт? ' : 'Нет аккаунта? '}
              <button type="button" onClick={() => switchMode(isRegister ? 'login' : 'register')}>
                {isRegister ? 'Войти' : 'Зарегистрироваться'}
              </button>
            </p>
          </form>
        </section>
      </div>
    </main>
  );
}

type HomeSummary = ReturnType<typeof deriveHomeData>['summary'];
type HomeBucket = ReturnType<typeof deriveHomeData>['allocations'][number];

function BalanceCard({ data }: { data: HomeSummary }) {
  return (
    <section className="balance-card appear" style={{ '--delay': '80ms' } as CSSProperties}>
      <div className="balance-rows">
        <div className="balance-row">
          <span className="balance-row-label">Баланс</span>
          <div className="balance-row-amounts">
            <strong className="money balance-row-primary">{data.balance}</strong>
            <em className="money-secondary balance-row-secondary">{data.balanceSecondary}</em>
          </div>
        </div>
        <div className="balance-row">
          <span className="balance-row-label">Доход</span>
          <div className="balance-row-amounts">
            <b className="money balance-row-primary balance-row-income">{data.income}</b>
            <em className="money-secondary balance-row-secondary">{data.incomeSecondary}</em>
            {data.cryptoIncomeUsd > 0 && (
              <em className="money-secondary balance-row-secondary balance-row-crypto">
                + {formatNumber(data.cryptoIncomeUsd)} $ Крипта
              </em>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}


function BucketCards({ items, usdRateVnd }: { items: HomeBucket[]; usdRateVnd: number }) {
  return (
    <section className="bucket-list" aria-label="Корзины бюджета">
      {items.map((item, index) => (
        <article
          className="bucket-card appear"
          key={item.key}
          style={{ '--delay': `${210 + index * 70}ms` } as CSSProperties}
        >
          <div className="icon-bubble">
            <Icon name={item.icon} />
          </div>
          <div className="bucket-content">
            <div className="bucket-heading">
              <h2>
                {item.label} <span>— {item.percent}</span>
              </h2>
              <Icon name="chevron" />
            </div>
            <div className="bucket-metrics">
              <div>
                <span>Распределено</span>
                <MoneyStack amountVnd={item.allocatedVnd} usdRateVnd={usdRateVnd} />
              </div>
              <div>
                <span>Потрачено</span>
                <MoneyStack amountVnd={item.spentVnd} usdRateVnd={usdRateVnd} />
              </div>
              <div>
                <span>Осталось</span>
                <MoneyStack amountVnd={item.leftVnd} usdRateVnd={usdRateVnd} primaryClassName="warm" />
              </div>
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function DailyCard({ data, usdRateVnd }: { data: HomeSummary; usdRateVnd: number }) {
  return (
    <section className="daily-card appear" style={{ '--delay': '450ms' } as CSSProperties}>
      <div className="icon-bubble">
        <Icon name="calendar" />
      </div>
      <div className="daily-copy">
        <span>Сегодня можно потратить</span>
        <MoneyStack amountVnd={data.dailyAvailableVnd} usdRateVnd={usdRateVnd} />
      </div>
      <div className="daily-meter">
        <span>из {data.dailyTotal}</span>
        <em className="money-secondary">{formatUsdFromVnd(data.dailyTotalVnd, usdRateVnd)}</em>
        <div className="progress-track" aria-hidden="true">
          <i style={{ width: `${data.dailyProgress}%` }} />
        </div>
      </div>
    </section>
  );
}

type MandatoryProgress = ReturnType<typeof deriveMandatoryProgress>;

const STATUS_LABEL: Record<'paid' | 'partial' | 'waiting', string> = {
  paid: 'Оплачено',
  partial: 'Частично',
  waiting: 'Ожидает',
};

function MandatoryPaymentsCard({ data, usdRateVnd }: { data: MandatoryProgress; usdRateVnd: number }) {
  return (
    <section className="mandatory-progress-card appear" style={{ '--delay': '430ms' } as CSSProperties}>
      <div className="mandatory-progress-header">
        <h2 className="mandatory-progress-title">Обязательные платежи</h2>
        {data.hasActive ? (
          <span className="mp-paid-summary">
            Оплачено: {data.paidCount} из {data.activeCount}
          </span>
        ) : null}
      </div>
      {!data.hasActive ? (
        <div className="mandatory-progress-empty">
          <span>Пока нет обязательных платежей</span>
          <span className="mandatory-progress-hint">Добавьте их в настройках</span>
        </div>
      ) : (
        <>
          <div className="mp-payment-list">
            {data.paymentStatuses.map(({ payment, status }) => (
              <div key={payment.id} className="mp-payment-list-row">
                <div className="mp-payment-list-row-info">
                  <span className="mp-payment-list-row-name">{payment.name}</span>
                  <span className="mp-payment-list-row-meta">
                    {payment.dueDay} число · {formatVnd(payment.amountVnd)}
                  </span>
                  <em className="money-secondary">{formatUsdFromVnd(payment.amountVnd, usdRateVnd)}</em>
                </div>
                <span className={`mp-status-badge ${status}`}>{STATUS_LABEL[status]}</span>
              </div>
            ))}
          </div>
          <div className="mandatory-progress-rows">
            <div className="mandatory-progress-row">
              <span>Нужно на месяц</span>
              <MoneyStack amountVnd={data.totalVnd} usdRateVnd={usdRateVnd} />
            </div>
            <div className="mandatory-progress-row">
              <span>Собрано</span>
              <MoneyStack amountVnd={data.collectedVnd} usdRateVnd={usdRateVnd} />
            </div>
            <div className="mandatory-progress-row">
              <span>Осталось собрать</span>
              <MoneyStack amountVnd={data.remainingVnd} usdRateVnd={usdRateVnd} />
            </div>
          </div>
          <div className="progress-track mandatory-progress-bar" aria-hidden="true">
            <i style={{ width: `${data.progressPercent}%` }} />
          </div>
          {data.isFunded ? (
            <p className="mandatory-progress-funded">Обязательные платежи закрыты по сбору ✓</p>
          ) : data.nearest ? (
            <p className="mandatory-progress-nearest">
              Ближайший: {data.nearest.name} · {data.nearest.dueDay} число
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function BottomNav({
  activeScreen,
  onAdd,
  onNavigate,
}: {
  activeScreen: Screen;
  onAdd: () => void;
  onNavigate: (screen: Screen) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="Основная навигация">
      <button className={activeScreen === 'home' ? 'active' : ''} type="button" onClick={() => onNavigate('home')}>
        <Icon name={navItems[0].icon} />
        <span>{navItems[0].label}</span>
      </button>
      <button className={activeScreen === 'history' ? 'active' : ''} type="button" onClick={() => onNavigate('history')}>
        <Icon name={navItems[1].icon} />
        <span>{navItems[1].label}</span>
      </button>
      <button className="center-plus" type="button" aria-label="Добавить" onClick={onAdd}>
        <Icon name="plus" />
      </button>
      <button className={activeScreen === 'analytics' ? 'active' : ''} type="button" onClick={() => onNavigate('analytics')}>
        <Icon name={navItems[2].icon} />
        <span>{navItems[2].label}</span>
      </button>
      <button className={activeScreen === 'settings' ? 'active' : ''} type="button" onClick={() => onNavigate('settings')}>
        <Icon name={navItems[3].icon} />
        <span>{navItems[3].label}</span>
      </button>
    </nav>
  );
}

function DateControls({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const today = getTodayInputValue();
  const yesterday = getYesterdayInputValue();

  return (
    <section className="date-control-card" aria-label="Дата операции">
      <div className="date-control-label">
        <Icon name="calendar" />
        <span>Дата</span>
      </div>
      <div className="date-control-options">
        <button
          className={`date-chip${value === today ? ' active' : ''}`}
          type="button"
          onClick={() => onChange(today)}
        >
          Сегодня
        </button>
        <button
          className={`date-chip${value === yesterday ? ' active' : ''}`}
          type="button"
          onClick={() => onChange(yesterday)}
        >
          Вчера
        </button>
        <input
          className="date-input"
          aria-label="Выбрать дату операции"
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </section>
  );
}

function bucketKeyFromDisplayLabel(label: string) {
  return bucketByLabel[label] ?? 'lifestyle';
}

function bucketLabelFromKey(bucketKey?: BucketKey) {
  return bucketDisplayLabel[bucketKey ?? 'lifestyle'];
}

function resolveBucketFromCategory(
  category: string,
  merged: Record<BucketKey, string[]>,
): BucketKey {
  const order: BucketKey[] = ['needs', 'lifestyle', 'capital'];
  for (const key of order) {
    if (merged[key].includes(category)) {
      return key;
    }
  }
  return 'lifestyle';
}

function isMandatoryPaymentCategory(category: string, mandatoryPayments: MandatoryPayment[]): boolean {
  const lower = category.toLowerCase();
  return mandatoryPayments.some((p) => p.name.toLowerCase() === lower);
}

function getSelectableWallets(wallets: Wallet[]): Wallet[] {
  const activeWallets = wallets.filter((wallet) => !wallet.isArchived);
  return activeWallets.length > 0 ? activeWallets : createDefaultWallets();
}

function resolveDefaultWalletId(wallets: Wallet[], defaultWalletId: string): string {
  return wallets.some((wallet) => wallet.id === defaultWalletId) ? defaultWalletId : DEFAULT_WALLET_ID;
}

function getWalletName(wallets: Wallet[], defaultWalletId: string, walletId?: string): string {
  const fallbackWallet = wallets.find((wallet) => wallet.id === defaultWalletId) ?? wallets.find((wallet) => wallet.id === DEFAULT_WALLET_ID);
  return wallets.find((wallet) => wallet.id === walletId)?.name ?? fallbackWallet?.name ?? 'Донги';
}

function deriveWalletBalances(
  wallets: Wallet[],
  transactions: Transaction[],
  defaultWalletId: string,
): Record<string, number> {
  const walletIds = new Set(wallets.map((wallet) => wallet.id));
  const fallbackWalletId = walletIds.has(defaultWalletId) ? defaultWalletId : DEFAULT_WALLET_ID;
  const balances = wallets.reduce<Record<string, number>>((result, wallet) => {
    result[wallet.id] = isFiniteNumber(wallet.openingBalanceVnd) ? wallet.openingBalanceVnd : 0;
    return result;
  }, {});

  if (!walletIds.has(fallbackWalletId)) {
    balances[fallbackWalletId] = balances[fallbackWalletId] ?? 0;
  }

  for (const transaction of transactions) {
    if (transaction.type === 'transfer') {
      const fromId = transaction.fromWalletId && walletIds.has(transaction.fromWalletId) ? transaction.fromWalletId : fallbackWalletId;
      const toId = transaction.toWalletId && walletIds.has(transaction.toWalletId) ? transaction.toWalletId : fallbackWalletId;
      balances[fromId] = (balances[fromId] ?? 0) - transaction.amountVnd;
      balances[toId] = (balances[toId] ?? 0) + transaction.amountVnd;
      continue;
    }
    const walletId = transaction.walletId && walletIds.has(transaction.walletId) ? transaction.walletId : fallbackWalletId;
    balances[walletId] = balances[walletId] ?? 0;
    balances[walletId] += transaction.type === 'income' ? transaction.amountVnd : -transaction.amountVnd;
  }

  return balances;
}

function getAllQuickCategories(
  usage: Record<BucketKey, Record<string, number>>,
  merged: Record<BucketKey, string[]>,
): string[] {
  const buckets: BucketKey[] = ['needs', 'lifestyle', 'capital'];

  const totalUsage = new Map<string, number>();
  for (const key of buckets) {
    for (const [cat, count] of Object.entries(usage[key])) {
      totalUsage.set(cat, (totalUsage.get(cat) ?? 0) + count);
    }
  }

  const seen = new Set<string>();
  const all: string[] = [];
  for (const key of buckets) {
    for (const cat of merged[key]) {
      if (!seen.has(cat)) {
        seen.add(cat);
        all.push(cat);
      }
    }
  }

  const used = all
    .filter((cat) => (totalUsage.get(cat) ?? 0) > 0)
    .sort((a, b) => (totalUsage.get(b) ?? 0) - (totalUsage.get(a) ?? 0));

  const unused = all.filter((cat) => (totalUsage.get(cat) ?? 0) === 0);

  const resultSeen = new Set<string>();
  const result: string[] = [];
  for (const cat of [...used, ...unused]) {
    if (!resultSeen.has(cat)) {
      resultSeen.add(cat);
      result.push(cat);
    }
  }
  return result.length > 0 ? result.slice(0, 8) : ['Другое'];
}

function QuickAddOverlay({
  closing,
  onClose,
  onSubmit,
  onTransferSubmit,
  usdRateVnd,
  budgetRule,
  activeMonth,
  expenseCategoryOptions,
  categoryUsage,
  mandatoryPayments,
  wallets,
  defaultWalletId,
}: {
  closing: boolean;
  onClose: () => void;
  onSubmit: (
    mode: 'income' | 'expense',
    amountVnd: number,
    bucket: BucketKey,
    category: string,
    createdAt: string,
    walletId: string,
    incomeDistributionMode?: 'auto' | 'manual',
    incomeTargetBuckets?: BucketKey[],
  ) => void;
  onTransferSubmit: (amountUsd: number, amountVnd: number, rateVnd: number, createdAt: string) => void;
  usdRateVnd: number;
  budgetRule: BudgetRule;
  activeMonth: string;
  expenseCategoryOptions: Record<BucketKey, string[]>;
  categoryUsage: Record<BucketKey, Record<string, number>>;
  mandatoryPayments: MandatoryPayment[];
  wallets: Wallet[];
  defaultWalletId: string;
}) {
  const [mode, setMode] = useState<'income' | 'expense' | 'transfer'>('expense');
  const selectableWallets = getSelectableWallets(wallets);
  const resolvedDefaultWalletId = resolveDefaultWalletId(selectableWallets, defaultWalletId);
  const allQuickCats = getAllQuickCategories(categoryUsage, expenseCategoryOptions);
  const [selectedExpenseCategory, setSelectedExpenseCategory] = useState<string>(
    () => getAllQuickCategories(categoryUsage, expenseCategoryOptions)[0] ?? 'Другое',
  );
  const [showFullCatList, setShowFullCatList] = useState(false);
  const [amountDigits, setAmountDigits] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => getDefaultQuickAddDate(activeMonth));
  const [selectedMandatoryPaymentId, setSelectedMandatoryPaymentId] = useState<string | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState(resolvedDefaultWalletId);
  const [incomeAutoDistribution, setIncomeAutoDistribution] = useState(true);
  const [manualIncomeTargets, setManualIncomeTargets] = useState<BucketKey[]>(['needs']);
  const activeMandatoryPayments = mandatoryPayments.filter((p) => p.isActive);
  const isIncome = mode === 'income';
  const isTransfer = mode === 'transfer';
  const selectedWalletIsValid = selectableWallets.some((wallet) => wallet.id === selectedWalletId);
  const effectiveWalletId = selectedWalletIsValid ? selectedWalletId : resolvedDefaultWalletId;
  const inputCurrency: CurrencyCode = isTransfer || effectiveWalletId === 'crypto' ? 'USD' : 'VND';
  const isCryptoInput = inputCurrency === 'USD';
  const safeUsdRateVnd = usdRateVnd > 0 ? usdRateVnd : DEFAULT_USD_RATE_VND;
  const inputAmount = Number(amountDigits || 0);
  const amountVnd = isCryptoInput ? Math.round(inputAmount * safeUsdRateVnd) : inputAmount;
  const amountSuggestions = isCryptoInput ? [50, 100, 500] : getAmountSuggestions(amountDigits);
  const canSubmit = inputAmount > 0;
  const primaryAmount = isCryptoInput ? formatUsdAmount(inputAmount) : formatVnd(amountVnd);
  const secondaryAmount = isCryptoInput ? formatApproxVnd(amountVnd) : formatUsdFromVnd(amountVnd, usdRateVnd);
  const resolvedExpenseBucket = resolveBucketFromCategory(selectedExpenseCategory, expenseCategoryOptions);
  const previewItems = quickAdd.incomeAllocations.map((item) => {
    const bucketKey = bucketKeyFromDisplayLabel(item.label);
    const percent = budgetRule[bucketKey];
    return {
      ...item,
      percent: `${percent}%`,
      amount: formatVnd(getIncomeAllocation(amountVnd, budgetRule)[bucketKey]),
    };
  });
  const categoryGroups: { key: BucketKey; label: string; categories: string[] }[] = [
    { key: 'needs', label: bucketDisplayLabel.needs, categories: expenseCategoryOptions.needs },
    { key: 'lifestyle', label: bucketDisplayLabel.lifestyle, categories: expenseCategoryOptions.lifestyle },
    { key: 'capital', label: bucketDisplayLabel.capital, categories: expenseCategoryOptions.capital },
  ];

  useEffect(() => {
    if (!selectedExpenseCategory && allQuickCats.length > 0) {
      setSelectedExpenseCategory(allQuickCats[0]);
    }
  }, [allQuickCats, selectedExpenseCategory]);

  const handleKeypad = (key: string) => {
    if (key === 'backspace') {
      setAmountDigits((current) => current.slice(0, -1));
      return;
    }

    if (key === ',') {
      return;
    }

    setAmountDigits((current) => {
      const next = current === '0' ? key : `${current}${key}`;
      return next.replace(/^0+(?=\d)/, '').slice(0, 12);
    });
  };

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }

    if (isTransfer) {
      onTransferSubmit(inputAmount, amountVnd, safeUsdRateVnd, dateInputValueToIso(selectedDate));
      setAmountDigits('');
      return;
    }

    const category = isIncome ? quickAdd.incomeCategory : selectedExpenseCategory;
    const bucketKey = isIncome
      ? ('needs' as BucketKey)
      : selectedMandatoryPaymentId
        ? ('needs' as BucketKey)
        : resolvedExpenseBucket;
    onSubmit(
      mode,
      amountVnd,
      bucketKey,
      category,
      dateInputValueToIso(selectedDate),
      effectiveWalletId,
      isIncome && !incomeAutoDistribution ? 'manual' : 'auto',
      isIncome && !incomeAutoDistribution ? manualIncomeTargets : undefined,
    );
    setAmountDigits('');
    setSelectedMandatoryPaymentId(null);
  };

  const selectSuggestion = (value: number) => {
    setAmountDigits(String(value));
  };

  const toggleManualIncomeTarget = (bucketKey: BucketKey) => {
    setManualIncomeTargets((current) => {
      if (current.includes(bucketKey)) {
        return current.length > 1 ? current.filter((key) => key !== bucketKey) : current;
      }

      return [...current, bucketKey];
    });
  };

  return (
    <section className={`quick-add ${closing ? 'closing' : ''}`} aria-label="Быстрое добавление">
      <div className="quick-add-inner">
        <header className="quick-header">
          <button className="quick-round-button" type="button" aria-label="Назад" onClick={onClose}>
            <Icon name="arrowLeft" />
          </button>
          <h2>Быстрое добавление</h2>
          <button className="quick-round-button" type="button" aria-label="Помощь">
            <Icon name="help" />
          </button>
        </header>

        <div className="quick-stack">
          {!isTransfer ? (
            <div className="quick-segmented" data-mode={mode}>
              <i aria-hidden="true" />
              <button
                className={isIncome ? 'active' : ''}
                type="button"
                onClick={() => {
                  setMode('income');
                  setSelectedMandatoryPaymentId(null);
                }}
              >
                Доход
              </button>
              <button className={!isIncome ? 'active' : ''} type="button" onClick={() => setMode('expense')}>
                Расход
              </button>
            </div>
          ) : null}

          {!isTransfer ? (
            <button
              className="quick-transfer-trigger"
              type="button"
              onClick={() => {
                setMode('transfer');
                setAmountDigits('');
              }}
            >
              Крипта → Донги
            </button>
          ) : (
            <button
              className="quick-transfer-trigger active"
              type="button"
              onClick={() => {
                setMode('expense');
                setAmountDigits('');
              }}
            >
              ← Назад к операциям
            </button>
          )}

          {isTransfer ? (
            <section className="quick-wallet-card transfer-info-card" aria-label="Конвертация">
              <div className="quick-section-label">Конвертация</div>
              <div className="transfer-route">
                <span className="wallet-chip active">Крипта</span>
                <span className="transfer-arrow">→</span>
                <span className="wallet-chip active">Донги</span>
              </div>
            </section>
          ) : null}

          {!isTransfer ? (
          <section className="quick-wallet-card" aria-label="Кошелёк">
            <div className="quick-section-label">Кошелёк</div>
            <div className="quick-wallet-options">
              {selectableWallets.map((wallet) => (
                <button
                  key={wallet.id}
                  className={`wallet-chip${selectedWalletId === wallet.id ? ' active' : ''}`}
                  type="button"
                  onClick={() => setSelectedWalletId(wallet.id)}
                >
                  {wallet.name}
                </button>
              ))}
            </div>
          </section>
          ) : null}

          <section className="quick-amount-card">
            <div className="quick-amount-copy">
              <strong className="money">{primaryAmount}</strong>
              <span className="money-secondary">{secondaryAmount}</span>
            </div>
            <button
              className="quick-amount-submit"
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label={isTransfer ? 'Конвертировать' : isIncome ? 'Добавить доход' : 'Добавить расход'}
              title={isTransfer ? 'Конвертировать' : isIncome ? 'Добавить доход' : 'Добавить расход'}
            >
              <Icon name="plus" />
            </button>
          </section>

          <section className="amount-suggestions" aria-label="Быстрые варианты суммы">
            {amountSuggestions.length ? (
              <>
                <span>Быстрые варианты</span>
                <div className="suggestion-chips">
                  {amountSuggestions.map((suggestion) => (
                    <button className="suggestion-chip money" type="button" key={suggestion} onClick={() => selectSuggestion(suggestion)}>
                      {isCryptoInput ? formatUsdAmount(suggestion) : formatVnd(suggestion)}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p>Введите сумму или выберите быстрый вариант</p>
            )}
          </section>

          {!isTransfer && isIncome ? (
            <section className="quick-allocation-card">
              <div className="quick-allocation-header">
                <div className="quick-section-label">
                  Автоматическое распределение
                  <Icon name="info" />
                </div>
                <button
                  className={`income-distribution-toggle${incomeAutoDistribution ? ' active' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={incomeAutoDistribution}
                  onClick={() => setIncomeAutoDistribution((current) => !current)}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
              {incomeAutoDistribution ? (
                <>
                  <div className="quick-allocation-grid">
                    {previewItems.map((item) => (
                      <div className="quick-allocation-item" key={item.label}>
                        <div className="icon-bubble">
                          <Icon name={item.icon} />
                        </div>
                        <span>{item.label}</span>
                        <strong>{item.percent}</strong>
                        <b className="money">{item.amount}</b>
                      </div>
                    ))}
                  </div>
                  <p>Автораспределение по правилу бюджета.</p>
                </>
              ) : (
                <>
                  <div className="manual-income-buckets" aria-label="Куда отправить доход">
                    {quickAdd.incomeAllocations.map((item) => {
                      const bucketKey = bucketKeyFromDisplayLabel(item.label);
                      return (
                        <button
                          key={bucketKey}
                          className={`manual-income-bucket${manualIncomeTargets.includes(bucketKey) ? ' active' : ''}`}
                          type="button"
                          onClick={() => toggleManualIncomeTarget(bucketKey)}
                        >
                          <Icon name={item.icon} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p>
                    {manualIncomeTargets.length === 1
                      ? 'Весь доход будет отправлен в выбранную корзину.'
                      : 'Доход будет разделён поровну между выбранными корзинами.'}
                  </p>
                </>
              )}
            </section>
          ) : !isTransfer ? (
            <section className="quick-bucket-card">
              {activeMandatoryPayments.length > 0 ? (
                <div className="quick-mandatory-section">
                  <div className="quick-section-label">Обязательные платежи</div>
                  <div className="quick-mandatory-chips">
                    {activeMandatoryPayments.map((payment) => (
                      <button
                        key={payment.id}
                        className={`mandatory-payment-chip${selectedMandatoryPaymentId === payment.id ? ' active' : ''}`}
                        type="button"
                        onClick={() => {
                          setSelectedMandatoryPaymentId(payment.id);
                          setSelectedExpenseCategory(payment.name);
                          setAmountDigits(String(isCryptoInput ? Math.round(payment.amountVnd / safeUsdRateVnd) : payment.amountVnd));
                        }}
                      >
                        <span className="mandatory-chip-name">{payment.name}</span>
                        <span className="mandatory-chip-amount money">{formatVnd(payment.amountVnd)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="quick-section-label">Быстрые категории</div>
              <div className="quick-cat-fast">
                {allQuickCats.map((cat: string) => (
                  <button
                    key={cat}
                    className={`category-chip${selectedExpenseCategory === cat ? ' active' : ''}`}
                    type="button"
                    onClick={() => {
                      setSelectedExpenseCategory(cat);
                      setSelectedMandatoryPaymentId(null);
                    }}
                  >
                    {cat}
                  </button>
                ))}
                <button
                  className={`quick-cat-toggle${showFullCatList ? ' active' : ''}`}
                  type="button"
                  onClick={() => setShowFullCatList((v) => !v)}
                >
                  Категории
                </button>
              </div>
              {showFullCatList ? (
                <div className="quick-cat-all">
                  {categoryGroups.map((group) => (
                    <div className="quick-cat-group" key={group.key}>
                      <span>{group.label}</span>
                      <div className="quick-cat-group-chips">
                        {group.categories.map((cat: string) => (
                          <button
                            key={`${group.key}-${cat}`}
                            className={`category-chip${selectedExpenseCategory === cat ? ' active' : ''}`}
                            type="button"
                            onClick={() => {
                              setSelectedExpenseCategory(cat);
                              setSelectedMandatoryPaymentId(null);
                              setShowFullCatList(false);
                            }}
                          >
                            {cat}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="keypad" aria-label="Цифровая клавиатура">
            {quickAdd.keypad.map((key) => (
              <button
                className="keypad-key"
                type="button"
                key={key}
                aria-label={key === 'backspace' ? 'Удалить' : key}
                onClick={() => handleKeypad(key)}
              >
                {key === 'backspace' ? <Icon name="backspace" /> : key}
              </button>
            ))}
          </div>

        </div>
      </div>
    </section>
  );
}

function EditTransactionOverlay({
  transaction,
  usdRateVnd,
  expenseCategoryOptions,
  categoryUsage,
  mandatoryPayments,
  onCancel,
  onSave,
}: {
  transaction: Transaction;
  usdRateVnd: number;
  expenseCategoryOptions: Record<BucketKey, string[]>;
  categoryUsage: Record<BucketKey, Record<string, number>>;
  mandatoryPayments: MandatoryPayment[];
  onCancel: () => void;
  onSave: (transaction: Transaction) => void;
}) {
  const [amountDigits, setAmountDigits] = useState(String(transaction.amountVnd));
  const [category, setCategory] = useState(transaction.category);
  const [showFullCatList, setShowFullCatList] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => isoToDateInputValue(transaction.createdAt));
  const amountVnd = Number(amountDigits || 0);
  const canSave = amountVnd > 0 && category.trim().length > 0;
  const allQuickCats = getAllQuickCategories(categoryUsage, expenseCategoryOptions);
  const categoryGroups: { key: BucketKey; label: string; categories: string[] }[] = [
    { key: 'needs', label: bucketDisplayLabel.needs, categories: expenseCategoryOptions.needs },
    { key: 'lifestyle', label: bucketDisplayLabel.lifestyle, categories: expenseCategoryOptions.lifestyle },
    { key: 'capital', label: bucketDisplayLabel.capital, categories: expenseCategoryOptions.capital },
  ];

  const selectExpenseCategory = (nextCategory: string, closeList = false) => {
    setCategory(nextCategory);
    if (closeList) {
      setShowFullCatList(false);
    }
  };

  const handleKeypad = (key: string) => {
    if (key === 'backspace') {
      setAmountDigits((current) => current.slice(0, -1));
      return;
    }

    if (key === ',') {
      return;
    }

    setAmountDigits((current) => {
      const next = current === '0' ? key : `${current}${key}`;
      return next.replace(/^0+(?=\d)/, '').slice(0, 12);
    });
  };

  const handleSave = () => {
    if (!canSave) {
      return;
    }

    const nextBucket =
      transaction.type === 'expense'
        ? isMandatoryPaymentCategory(category.trim(), mandatoryPayments)
          ? ('needs' as BucketKey)
          : resolveBucketFromCategory(category.trim(), expenseCategoryOptions)
        : undefined;

    onSave({
      ...transaction,
      amountVnd,
      usdApprox: Math.round(amountVnd / usdRateVnd),
      bucket: nextBucket,
      category: category.trim(),
      createdAt: dateInputValueToIso(selectedDate),
    });
  };

  return (
    <section className="edit-transaction-overlay" aria-label="Редактировать операцию">
      <div className="edit-sheet">
        <header className="edit-header">
          <h2>Редактировать операцию</h2>
          <button className="quick-round-button" type="button" aria-label="Закрыть" onClick={onCancel}>
            <Icon name="arrowLeft" />
          </button>
        </header>

        <section className="quick-amount-card edit-amount-card">
          <strong className="money">{formatVnd(amountVnd)}</strong>
          <span className="money-secondary">{formatUsdFromVnd(amountVnd, usdRateVnd)}</span>
        </section>

        {transaction.type === 'expense' ? (
          <section className="quick-bucket-card edit-category-card">
            <div className="quick-section-label">Категория</div>
            <div className="edit-selected-category">{category.trim() || 'Категория не выбрана'}</div>
            <div className="quick-cat-fast">
              {allQuickCats.map((cat: string) => (
                <button
                  key={cat}
                  className={`category-chip${category === cat ? ' active' : ''}`}
                  type="button"
                  onClick={() => selectExpenseCategory(cat)}
                >
                  {cat}
                </button>
              ))}
              <button
                className={`quick-cat-toggle${showFullCatList ? ' active' : ''}`}
                type="button"
                onClick={() => setShowFullCatList((v) => !v)}
              >
                Категории
              </button>
            </div>
            {showFullCatList ? (
              <div className="quick-cat-all">
                {categoryGroups.map((group) => (
                  <div className="quick-cat-group" key={group.key}>
                    <span>{group.label}</span>
                    <div className="quick-cat-group-chips">
                      {group.categories.map((cat: string) => (
                        <button
                          key={`${group.key}-${cat}`}
                          className={`category-chip${category === cat ? ' active' : ''}`}
                          type="button"
                          onClick={() => selectExpenseCategory(cat, true)}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : (
          <label className="edit-category">
            <span>Категория</span>
            <input value={category} onChange={(event) => setCategory(event.target.value)} />
          </label>
        )}

        <DateControls value={selectedDate} onChange={setSelectedDate} />

        <div className="edit-actions">
          <button className="edit-cancel" type="button" onClick={onCancel}>
            Отмена
          </button>
          <button className="quick-primary" type="button" onClick={handleSave} disabled={!canSave}>
            Сохранить
          </button>
        </div>

        <div className="keypad edit-keypad" aria-label="Цифровая клавиатура">
          {quickAdd.keypad.map((key) => (
            <button
              className="keypad-key"
              type="button"
              key={key}
              aria-label={key === 'backspace' ? 'Удалить' : key}
              onClick={() => handleKeypad(key)}
            >
              {key === 'backspace' ? <Icon name="backspace" /> : key}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function HistoryScreen({
  transactions,
  usdRateVnd,
  activeMonth,
  onDeleteTransaction,
  onEditTransaction,
  mandatoryPayments,
  wallets,
  defaultWalletId,
}: {
  transactions: Transaction[];
  usdRateVnd: number;
  activeMonth: string;
  onDeleteTransaction: (transactionId: string) => void;
  onEditTransaction: (transaction: Transaction) => void;
  mandatoryPayments: MandatoryPayment[];
  wallets: Wallet[];
  defaultWalletId: string;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('month');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const mandatoryNames = new Set(mandatoryPayments.map((p) => p.name.toLowerCase()));
  const filteredTransactions = filterTransactions(transactions, period, activeMonth).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const incomeSum = filteredTransactions.reduce(
    (sum, transaction) => sum + (transaction.type === 'income' ? transaction.amountVnd : 0),
    0,
  );
  const expenseSum = filteredTransactions.reduce(
    (sum, transaction) => sum + (transaction.type === 'expense' ? transaction.amountVnd : 0),
    0,
  );
  const balance = incomeSum - expenseSum;

  return (
    <section className="history-screen appear">
      <header className="history-header">
        <h1>
          <span>Ис</span>тория
        </h1>
      </header>

      <div className="history-segmented" data-period={period}>
        <i aria-hidden="true" />
        <button className={period === 'day' ? 'active' : ''} type="button" onClick={() => setPeriod('day')}>
          День
        </button>
        <button className={period === 'week' ? 'active' : ''} type="button" onClick={() => setPeriod('week')}>
          Неделя
        </button>
        <button className={period === 'month' ? 'active' : ''} type="button" onClick={() => setPeriod('month')}>
          Месяц
        </button>
      </div>

      <section className="history-summary-card">
        <div>
          <span>Доходы</span>
          <strong className="money positive">{formatVnd(incomeSum)}</strong>
          <em className="money-secondary">{formatUsdFromVnd(incomeSum, usdRateVnd)}</em>
        </div>
        <div>
          <span>Расходы</span>
          <strong className="money negative">{formatVnd(expenseSum)}</strong>
          <em className="money-secondary">{formatUsdFromVnd(expenseSum, usdRateVnd)}</em>
        </div>
        <div>
          <span>Баланс</span>
          <strong className="money">{formatVnd(balance)}</strong>
          <em className="money-secondary">{formatUsdFromVnd(balance, usdRateVnd)}</em>
        </div>
      </section>

      <section className="transaction-list" aria-label="Операции">
        {filteredTransactions.length ? (
          filteredTransactions.map((transaction) => (
            <article className={`transaction-card ${pendingDeleteId === transaction.id ? 'confirming-delete' : ''}`} key={transaction.id}>
              <div className={`transaction-icon ${transaction.type}`}>
                <Icon name={transaction.type === 'expense' ? 'tag' : 'trend'} />
              </div>
              <div className="transaction-copy">
                <h2>{transaction.category}</h2>
                <span>{formatTransactionDate(transaction.createdAt)}</span>
                <p>
                  {transaction.type === 'income' ? 'Доход' : transaction.type === 'transfer' ? 'Обмен' : 'Расход'}
                  {transaction.bucket ? ` · ${bucketDisplayLabel[transaction.bucket]}` : ''}
                </p>
                {transaction.type === 'transfer' ? (
                  <span className="wallet-tx-badge transfer">Крипта → Донги</span>
                ) : (
                  <span className={`wallet-tx-badge ${transaction.walletId === 'crypto' ? 'crypto' : 'dongi'}`}>
                    {getWalletName(wallets, defaultWalletId, transaction.walletId)}
                  </span>
                )}
                {transaction.type === 'expense' &&
                transaction.bucket === 'needs' &&
                mandatoryNames.has(transaction.category.toLowerCase()) ? (
                  <span className="mandatory-tx-badge">Обязательный платёж</span>
                ) : null}
              </div>
              <div className="transaction-amount">
                <MoneyStack
                  amountVnd={transaction.amountVnd}
                  usdRateVnd={usdRateVnd}
                  primaryClassName={transaction.type === 'income' ? 'positive' : transaction.type === 'transfer' ? 'transfer' : 'negative'}
                  prefix={transaction.type === 'income' ? '+ ' : ''}
                />
                <div className="transaction-actions">
                  <button
                    className="edit-transaction"
                    type="button"
                    aria-label="Редактировать операцию"
                    onClick={() => {
                      setPendingDeleteId(null);
                      onEditTransaction(transaction);
                    }}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="delete-transaction"
                    type="button"
                    aria-label="Удалить операцию"
                    onClick={() => {
                      if (pendingDeleteId === transaction.id) {
                        onDeleteTransaction(transaction.id);
                        setPendingDeleteId(null);
                        return;
                      }

                      setPendingDeleteId(transaction.id);
                    }}
                  >
                    {pendingDeleteId === transaction.id ? 'Удалить?' : <Icon name="trash" />}
                  </button>
                </div>
              </div>
            </article>
          ))
        ) : (
          <div className="history-empty">
            <strong>Пока нет операций</strong>
            <span>Добавьте доход или расход через кнопку +</span>
          </div>
        )}
      </section>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CurrencyDropdown({
  label,
  value,
  isOpen,
  onToggle,
  onChange,
}: {
  label: string;
  value: CurrencyCode;
  isOpen: boolean;
  onToggle: () => void;
  onChange: (value: CurrencyCode) => void;
}) {
  const selected = currencyOptionByCode[value];

  return (
    <div className={`currency-dropdown-row${isOpen ? ' open' : ''}`}>
      <span>{label}</span>
      <div className="currency-dropdown">
        <button
          className="currency-dropdown-button"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={onToggle}
        >
          <span className="currency-dropdown-value">
            {selected.code} {selected.symbol}
          </span>
          <Icon name="chevron" />
        </button>
        {isOpen ? (
          <div className="currency-dropdown-menu" role="listbox" aria-label={label}>
            {currencyOptions.map((option) => (
              <button
                className={`currency-dropdown-option${option.code === value ? ' active' : ''}`}
                key={option.code}
                type="button"
                role="option"
                aria-selected={option.code === value}
                onClick={() => onChange(option.code)}
              >
                <strong>
                  {option.code} {option.symbol}
                </strong>
                <span>{option.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BudgetRuleEditor({
  budgetRule,
  onBudgetRuleChange,
}: {
  budgetRule: BudgetRule;
  onBudgetRuleChange: (rule: BudgetRule) => void;
}) {
  const [draftRule, setDraftRule] = useState<Record<BucketKey, string>>({
    needs: String(budgetRule.needs),
    lifestyle: String(budgetRule.lifestyle),
    capital: String(budgetRule.capital),
  });

  useEffect(() => {
    setDraftRule({
      needs: String(budgetRule.needs),
      lifestyle: String(budgetRule.lifestyle),
      capital: String(budgetRule.capital),
    });
  }, [budgetRule]);

  const parsedRule: BudgetRule = {
    needs: Number(draftRule.needs || 0),
    lifestyle: Number(draftRule.lifestyle || 0),
    capital: Number(draftRule.capital || 0),
  };
  const total = parsedRule.needs + parsedRule.lifestyle + parsedRule.capital;
  const isValid = isValidBudgetRule(parsedRule);

  const handleChange = (key: BucketKey, value: string) => {
    const digitsOnly = value.replace(/\D/g, '').slice(0, 3);
    const clampedValue = digitsOnly ? String(Math.min(100, Number(digitsOnly))) : '';
    const nextDraft = { ...draftRule, [key]: clampedValue };
    const nextRule: BudgetRule = {
      needs: Number(nextDraft.needs || 0),
      lifestyle: Number(nextDraft.lifestyle || 0),
      capital: Number(nextDraft.capital || 0),
    };

    setDraftRule(nextDraft);

    if (isValidBudgetRule(nextRule)) {
      onBudgetRuleChange(nextRule);
    }
  };

  const rows: { key: BucketKey; label: string }[] = [
    { key: 'needs', label: 'Обязательное' },
    { key: 'lifestyle', label: 'Стиль жизни' },
    { key: 'capital', label: 'Капитал' },
  ];

  return (
    <div className="budget-rule-editor">
      {rows.map((row) => (
        <label className="budget-rule-row" key={row.key}>
          <span>{row.label}</span>
          <div className="budget-rule-input-wrap">
            <input
              aria-label={`${row.label}, процент бюджета`}
              className="budget-rule-input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draftRule[row.key]}
              onChange={(event) => handleChange(row.key, event.target.value)}
            />
            <span>%</span>
          </div>
        </label>
      ))}
      <div className={`budget-rule-total${isValid ? ' valid' : ' invalid'}`}>
        <span>Итого: {total}%</span>
        {!isValid ? <strong>Сумма должна быть 100%</strong> : null}
      </div>
    </div>
  );
}

function SettingsScreen({
  usdRateInput,
  onUsdRateInputChange,
  onUsdRateInputFocusChange,
  exchangeRateStatus,
  exchangeRateUpdatedAt,
  exchangeRateError,
  onUpdateExchangeRate,
  currencySettings,
  onCurrencySettingsChange,
  budgetRule,
  onBudgetRuleChange,
  dailySpendDays,
  onDailySpendDaysChange,
  weekStartDay,
  onWeekStartDayChange,
  mergedExpenseCategories,
  allExpenseCategoryNames,
  customCategories,
  hiddenCategories,
  onAddCustomCategory,
  onDeleteCustomCategory,
  onHideCategory,
  activeMonth,
  backupStatus,
  onExportData,
  onImportFile,
  resetPending,
  onResetClick,
  mandatoryPayments,
  onAddMandatoryPayment,
  onDeleteMandatoryPayment,
  onToggleMandatoryPayment,
  firebaseUser,
  cloudStatus,
  cloudError,
  onGoogleAuth,
  onSignOut,
  wallets,
  defaultWalletId,
  walletBalances,
  usdRateVnd,
}: {
  usdRateInput: string;
  onUsdRateInputChange: (value: string) => void;
  onUsdRateInputFocusChange: (isFocused: boolean) => void;
  exchangeRateStatus: ExchangeRateStatus;
  exchangeRateUpdatedAt: string | null;
  exchangeRateError: string | null;
  onUpdateExchangeRate: () => Promise<void>;
  currencySettings: CurrencySettings;
  onCurrencySettingsChange: (settings: CurrencySettings) => void;
  budgetRule: BudgetRule;
  onBudgetRuleChange: (rule: BudgetRule) => void;
  dailySpendDays: number;
  onDailySpendDaysChange: (days: number) => void;
  weekStartDay: WeekStartDay;
  onWeekStartDayChange: (day: WeekStartDay) => void;
  mergedExpenseCategories: Record<BucketKey, string[]>;
  allExpenseCategoryNames: string[];
  customCategories: Record<BucketKey, string[]>;
  hiddenCategories: Record<BucketKey, string[]>;
  onAddCustomCategory: (bucketKey: BucketKey, name: string) => void;
  onDeleteCustomCategory: (bucketKey: BucketKey, name: string) => void;
  onHideCategory: (name: string) => void;
  activeMonth: string;
  backupStatus: { type: 'success' | 'error'; text: string } | null;
  onExportData: () => void;
  onImportFile: (file: File) => void;
  resetPending: boolean;
  onResetClick: () => void;
  mandatoryPayments: MandatoryPayment[];
  onAddMandatoryPayment: (name: string, amountVnd: number, dueDay: number) => void;
  onDeleteMandatoryPayment: (id: string) => void;
  onToggleMandatoryPayment: (id: string) => void;
  firebaseUser: User | null;
  cloudStatus: CloudStatus;
  cloudError: string;
  onGoogleAuth: () => Promise<void>;
  onSignOut: () => Promise<void>;
  wallets: Wallet[];
  defaultWalletId: string;
  walletBalances: Record<string, number>;
  usdRateVnd: number;
}) {
  const [newCatInput, setNewCatInput] = useState('');
  const [catValidation, setCatValidation] = useState('');
  const [selectedCategoryForDelete, setSelectedCategoryForDelete] = useState<string | null>(null);
  const [openCurrencyMenu, setOpenCurrencyMenu] = useState<keyof CurrencySettings | null>(null);
  const [mpName, setMpName] = useState('');
  const [mpAmount, setMpAmount] = useState('');
  const [mpDay, setMpDay] = useState('');
  const [mpValidation, setMpValidation] = useState('');
  const [cloudActionPending, setCloudActionPending] = useState(false);
  const [dailySpendInput, setDailySpendInput] = useState(String(dailySpendDays));
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const categoryBucketKeys: BucketKey[] = ['needs', 'lifestyle', 'capital'];
  const visibleWallets = getSelectableWallets(wallets);
  const combinedCategoryItems = categoryBucketKeys.reduce<
    { name: string; isCustom: boolean; customBuckets: BucketKey[]; presetBuckets: BucketKey[] }[]
  >((items, bucketKey) => {
    for (const cat of mergedExpenseCategories[bucketKey]) {
      const existingIndex = items.findIndex((item) => item.name.toLowerCase() === cat.toLowerCase());
      const isCustom = customCategories[bucketKey].includes(cat);
      const presetHidden = hiddenCategories[bucketKey].some((hidden) => hidden.toLowerCase() === cat.toLowerCase());
      const isPreset = expenseCategories[bucketKey].some((preset) => preset.toLowerCase() === cat.toLowerCase()) && !presetHidden;

      if (existingIndex === -1) {
        items.push({
          name: cat,
          isCustom: isCustom && !isPreset,
          customBuckets: isCustom ? [bucketKey] : [],
          presetBuckets: isPreset ? [bucketKey] : [],
        });
        continue;
      }

      if (isCustom) {
        items[existingIndex].customBuckets.push(bucketKey);
      }
      if (isPreset) {
        items[existingIndex].presetBuckets.push(bucketKey);
        items[existingIndex].isCustom = false;
      }
    }

    return items;
  }, []);

  const handleAddCategory = () => {
    const trimmed = newCatInput.trim();
    if (!trimmed) {
      setCatValidation('Введите название');
      return;
    }
    const isDuplicate = allExpenseCategoryNames.some((cat) => cat.toLowerCase() === trimmed.toLowerCase());
    if (isDuplicate) {
      setCatValidation('Такая категория уже есть');
      return;
    }
    onAddCustomCategory('needs', trimmed);
    setNewCatInput('');
    setCatValidation('');
    setSelectedCategoryForDelete(null);
  };

  useEffect(() => {
    setDailySpendInput(String(dailySpendDays));
  }, [dailySpendDays]);

  const handleDailySpendInputChange = (value: string) => {
    const digits = value.replace(/\D/g, '');
    setDailySpendInput(digits);

    if (!digits) {
      return;
    }

    const nextDays = Number(digits);
    if (Number.isInteger(nextDays) && nextDays >= 1 && nextDays <= 365) {
      onDailySpendDaysChange(nextDays);
    }
  };

  const handleDailySpendInputBlur = () => {
    const nextDays = Number(dailySpendInput);
    if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > 365) {
      setDailySpendInput(String(dailySpendDays));
    }
  };

  const cloudStatusText: Record<CloudStatus, string> = {
    local: 'Локально',
    loading: 'Синхронизация',
    synced: 'Подключено',
    saving: 'Синхронизация',
    error: 'Ошибка',
  };
  const exchangeRateStatusText: Record<ExchangeRateStatus, string> = {
    idle: '',
    loading: 'Обновляем курс...',
    success: 'Курс обновлён',
    error: 'Не удалось обновить, используется ручной курс',
  };
  const isDailySpendPreset = DAILY_SPEND_DAY_OPTIONS.some((days) => days === dailySpendDays);

  const handleCloudAction = async () => {
    setCloudActionPending(true);
    try {
      if (firebaseUser) {
        await onSignOut();
      } else {
        await onGoogleAuth();
      }
    } finally {
      setCloudActionPending(false);
    }
  };

  return (
    <section className="settings-screen appear">
      <header className="settings-header">
        <h1>Настройки</h1>
        <p>Валюта, расчёты и приложение</p>
      </header>

      <section className="settings-card currency-settings-card">
        <h2>Валюта</h2>
        <CurrencyDropdown
          label="Основная валюта"
          value={currencySettings.primary}
          isOpen={openCurrencyMenu === 'primary'}
          onToggle={() => setOpenCurrencyMenu((current) => (current === 'primary' ? null : 'primary'))}
          onChange={(primary) => {
            onCurrencySettingsChange({ ...currencySettings, primary });
            setOpenCurrencyMenu(null);
          }}
        />
        <CurrencyDropdown
          label="Вторая валюта"
          value={currencySettings.secondary}
          isOpen={openCurrencyMenu === 'secondary'}
          onToggle={() => setOpenCurrencyMenu((current) => (current === 'secondary' ? null : 'secondary'))}
          onChange={(secondary) => {
            onCurrencySettingsChange({ ...currencySettings, secondary });
            setOpenCurrencyMenu(null);
          }}
        />
      </section>

      <section className="settings-card">
        <h2>Курс USD</h2>
        <div className="rate-editor">
          <span>1 $ =</span>
          <input
            aria-label="Курс USD во вьетнамских донгах"
            className="money"
            inputMode="numeric"
            pattern="[0-9]*"
            value={usdRateInput}
            onChange={(event) => onUsdRateInputChange(event.target.value)}
            onFocus={() => onUsdRateInputFocusChange(true)}
            onBlur={() => onUsdRateInputFocusChange(false)}
          />
          <span>₫</span>
        </div>
        <button
          className="rate-update-btn"
          type="button"
          onClick={() => void onUpdateExchangeRate()}
          disabled={exchangeRateStatus === 'loading'}
        >
          Обновить курс
        </button>
        {exchangeRateStatus !== 'idle' ? (
          <p className={`rate-update-status ${exchangeRateStatus}`}>
            {exchangeRateStatusText[exchangeRateStatus]}
            {exchangeRateStatus === 'error' && exchangeRateError ? `: ${exchangeRateError}` : ''}
          </p>
        ) : null}
        {exchangeRateUpdatedAt ? (
          <p className="rate-update-date">Обновлено: {formatExchangeRateDate(exchangeRateUpdatedAt)}</p>
        ) : null}
        <p>Курс используется только для примерного отображения долларов.</p>
      </section>

      <section className="settings-card">
        <h2>Правило бюджета</h2>
        <BudgetRuleEditor budgetRule={budgetRule} onBudgetRuleChange={onBudgetRuleChange} />
      </section>

      <section className="settings-card daily-spend-card">
        <h2>Дневной лимит</h2>
        <p className="daily-spend-helper">Сумма ‘Сегодня можно потратить’ делится на выбранное количество дней.</p>
        <div className="daily-spend-options" role="group" aria-label="Период расчёта дневного лимита">
          {DAILY_SPEND_DAY_OPTIONS.map((days) => (
            <button
              className={`daily-spend-option${dailySpendDays === days ? ' active' : ''}`}
              type="button"
              key={days}
              onClick={() => onDailySpendDaysChange(days)}
            >
              {days} дней
            </button>
          ))}
        </div>
        <label className={`daily-spend-custom${isDailySpendPreset ? '' : ' active'}`}>
          <span>Своё</span>
          <input
            aria-label="Своё количество дней для дневного лимита"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Своё число"
            value={dailySpendInput}
            onChange={(event) => handleDailySpendInputChange(event.target.value)}
            onBlur={handleDailySpendInputBlur}
          />
        </label>
        <div className="week-start-control">
          <span>Неделя начинается</span>
          <div className="week-start-options" role="group" aria-label="День начала недели">
            {WEEK_START_DAY_OPTIONS.map((day) => (
              <button
                className={`week-start-option${weekStartDay === day.value ? ' active' : ''}`}
                type="button"
                key={day.value}
                onClick={() => onWeekStartDayChange(day.value)}
              >
                {day.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-card wallet-balances-card">
        <h2>Кошельки</h2>
        <p className="wallet-balances-helper">Баланс считается из доходов и расходов.</p>
        <div className="wallet-balance-list">
          {visibleWallets.map((wallet) => (
            <div className="wallet-balance-row" key={wallet.id}>
              <div className="wallet-balance-copy">
                <span>{wallet.name}</span>
                <em>{wallet.id === defaultWalletId || wallet.isDefault ? 'Основной' : 'Отдельный счёт'}</em>
              </div>
              <MoneyStack amountVnd={walletBalances[wallet.id] ?? 0} usdRateVnd={usdRateVnd} />
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card mandatory-payments-card">
        <h2>Обязательные платежи</h2>
        <p className="mandatory-payments-helper">Квартира, байк и другие платежи месяца.</p>

        <div className="mp-list">
          {mandatoryPayments.length === 0 ? (
            <p className="mp-empty">Пока нет обязательных платежей</p>
          ) : (
            mandatoryPayments.map((payment) => (
              <div key={payment.id} className="mp-row">
                <div className="mp-row-info">
                  <span className="mp-name">{payment.name}</span>
                  <span className="mp-meta">
                    {formatVnd(payment.amountVnd)} · {payment.dueDay} число
                  </span>
                  <em className="money-secondary">{formatUsdFromVnd(payment.amountVnd, usdRateVnd)}</em>
                  <span className={`mp-status${payment.isActive ? ' active' : ' inactive'}`}>
                    {payment.isActive ? 'Активен' : 'Отключён'}
                  </span>
                </div>
                <div className="mp-row-actions">
                  <button
                    className="mp-toggle-btn"
                    type="button"
                    onClick={() => onToggleMandatoryPayment(payment.id)}
                  >
                    {payment.isActive ? 'Отключить' : 'Включить'}
                  </button>
                  <button
                    className="mp-delete-btn"
                    type="button"
                    aria-label={`Удалить ${payment.name}`}
                    onClick={() => onDeleteMandatoryPayment(payment.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mp-add-form">
          <input
            className="mp-input"
            type="text"
            placeholder="Название"
            value={mpName}
            onChange={(e) => {
              setMpName(e.target.value);
              setMpValidation('');
            }}
          />
          <input
            className="mp-input mp-input-number"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Сумма"
            value={mpAmount}
            onChange={(e) => {
              setMpAmount(e.target.value.replace(/[^0-9]/g, ''));
              setMpValidation('');
            }}
          />
          <input
            className="mp-input mp-input-day"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="День"
            value={mpDay}
            onChange={(e) => {
              setMpDay(e.target.value.replace(/[^0-9]/g, ''));
              setMpValidation('');
            }}
          />
          <button
            className="mp-add-btn"
            type="button"
            onClick={() => {
              const trimmedName = mpName.trim();
              if (!trimmedName) {
                setMpValidation('Введите название');
                return;
              }
              const amount = Number(mpAmount);
              if (!mpAmount || !Number.isFinite(amount) || amount <= 0) {
                setMpValidation('Введите сумму');
                return;
              }
              const day = Number(mpDay);
              if (!mpDay || !Number.isInteger(day) || day < 1 || day > 31) {
                setMpValidation('День от 1 до 31');
                return;
              }
              onAddMandatoryPayment(trimmedName, amount, day);
              setMpName('');
              setMpAmount('');
              setMpDay('');
              setMpValidation('');
            }}
          >
            Добавить
          </button>
        </div>
        {mpValidation ? <p className="mp-validation">{mpValidation}</p> : null}
      </section>

      <section className="settings-card">
        <h2>Категории расходов</h2>
        <div className="cat-manager">
          <div className="cat-list">
            {combinedCategoryItems.map((cat) => {
              const isSelected = selectedCategoryForDelete === cat.name;
              const canRemove = cat.isCustom ? cat.customBuckets.length > 0 : cat.presetBuckets.length > 0;
              return (
                <button
                  key={cat.name}
                  className={`cat-item${isSelected ? ' selected' : ''}`}
                  type="button"
                  onClick={() => setSelectedCategoryForDelete(cat.name)}
                >
                  <span className="cat-item-name">{cat.name}</span>
                  {isSelected && canRemove ? (
                    <span
                      className="cat-delete-btn"
                      role="button"
                      tabIndex={0}
                      aria-label={`${cat.isCustom ? 'Удалить' : 'Скрыть'} категорию ${cat.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (cat.isCustom) {
                          cat.customBuckets.forEach((bucketKey) => onDeleteCustomCategory(bucketKey, cat.name));
                        } else {
                          onHideCategory(cat.name);
                        }
                        setSelectedCategoryForDelete(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          if (cat.isCustom) {
                            cat.customBuckets.forEach((bucketKey) => onDeleteCustomCategory(bucketKey, cat.name));
                          } else {
                            onHideCategory(cat.name);
                          }
                          setSelectedCategoryForDelete(null);
                        }
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="cat-add-row">
            <input
              className="cat-add-input"
              type="text"
              placeholder="Новая категория"
              value={newCatInput}
              onChange={(e) => {
                setNewCatInput(e.target.value);
                setCatValidation('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCategory();
              }}
            />
            <button className="cat-add-btn" type="button" onClick={handleAddCategory}>
              Добавить
            </button>
          </div>
          {catValidation ? <p className="cat-validation">{catValidation}</p> : null}
        </div>
      </section>

      <section className="settings-card">
        <h2>Приложение</h2>
        <SettingsRow label="Хранение данных" value={firebaseUser ? 'Google Firestore + устройство' : 'На устройстве'} />
        <SettingsRow label="Автосохранение" value="Включено" />
        <div className="settings-backup-actions">
          <button className="settings-backup-btn" type="button" onClick={onExportData}>
            Экспорт данных
          </button>
          <button className="settings-backup-btn" type="button" onClick={() => importInputRef.current?.click()}>
            Импорт данных
          </button>
          <input
            ref={importInputRef}
            className="settings-file-input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onImportFile(file);
              }
              event.target.value = '';
            }}
          />
        </div>
        {backupStatus ? <p className={`settings-backup-status ${backupStatus.type}`}>{backupStatus.text}</p> : null}
        <button
          className={`settings-reset-btn${resetPending ? ' pending' : ''}`}
          type="button"
          onClick={onResetClick}
        >
          {resetPending ? 'Нажмите ещё раз' : 'Сбросить данные'}
        </button>
      </section>

      <section className="settings-card cloud-settings-card">
        <h2>Облако</h2>
        <SettingsRow label="Статус" value={cloudStatusText[cloudStatus]} />
        {firebaseUser?.email ? <SettingsRow label="Аккаунт" value={firebaseUser.email} /> : null}
        <p>Данные сохраняются в Google Firestore</p>
        {cloudError ? <p className="cloud-error">{cloudError}</p> : null}
        <button
          className="cloud-auth-btn"
          type="button"
          onClick={() => void handleCloudAction()}
          disabled={cloudActionPending || cloudStatus === 'loading' || cloudStatus === 'saving'}
        >
          {firebaseUser ? 'Выйти' : 'Войти через Google'}
        </button>
      </section>
    </section>
  );
}

type CategorySummary = {
  category: string;
  totalVnd: number;
  count: number;
  sharePercent: number;
};

function getTopExpenseCategories(transactions: Transaction[]): CategorySummary[] {
  const expenses = transactions.filter((t) => t.type === 'expense');
  const totalVnd = expenses.reduce((sum, t) => sum + t.amountVnd, 0);

  const map = new Map<string, { totalVnd: number; count: number }>();
  for (const t of expenses) {
    const entry = map.get(t.category);
    if (entry) {
      entry.totalVnd += t.amountVnd;
      entry.count += 1;
    } else {
      map.set(t.category, { totalVnd: t.amountVnd, count: 1 });
    }
  }

  return Array.from(map.entries())
    .map(([category, data]) => ({
      category,
      totalVnd: data.totalVnd,
      count: data.count,
      sharePercent: totalVnd > 0 ? Math.round((data.totalVnd / totalVnd) * 100) : 0,
    }))
    .sort((a, b) => b.totalVnd - a.totalVnd)
    .slice(0, 5);
}

function txOpsLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} операция`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} операции`;
  return `${n} операций`;
}

function AnalyticsScreen({
  transactions,
  monthlyState,
  usdRateVnd,
  activeMonth,
}: {
  transactions: Transaction[];
  monthlyState: MonthlyState;
  usdRateVnd: number;
  activeMonth: string;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('month');

  const filtered = filterTransactions(transactions, period, activeMonth);
  const incomeSumVnd = filtered.reduce((sum, t) => sum + (t.type === 'income' ? t.amountVnd : 0), 0);
  const expenseSumVnd = filtered.reduce((sum, t) => sum + (t.type === 'expense' ? t.amountVnd : 0), 0);
  const balanceVnd = incomeSumVnd - expenseSumVnd;
  const txCount = filtered.length;

  const periodLabel: Record<HistoryPeriod, string> = { day: 'за сегодня', week: 'за 7 дней', month: 'за текущий месяц' };
  const topCategories = getTopExpenseCategories(filtered);

  const bucketRows: { key: BucketKey; label: string; icon: IconName }[] = [
    { key: 'needs', label: 'Обязательное', icon: 'home' },
    { key: 'lifestyle', label: 'Стиль жизни', icon: 'cup' },
    { key: 'capital', label: 'Капитал', icon: 'trend' },
  ];

  return (
    <section className="analytics-screen appear">
      <header className="analytics-header">
        <h1>
          <span>Ана</span>литика
        </h1>
        <p>Расходы, категории и динамика</p>
      </header>

      <div className="analytics-period-seg" data-period={period}>
        <i aria-hidden="true" />
        <button className={period === 'day' ? 'active' : ''} type="button" onClick={() => setPeriod('day')}>
          День
        </button>
        <button className={period === 'week' ? 'active' : ''} type="button" onClick={() => setPeriod('week')}>
          Неделя
        </button>
        <button className={period === 'month' ? 'active' : ''} type="button" onClick={() => setPeriod('month')}>
          Месяц
        </button>
      </div>

      <section className="analytics-card appear" style={{ '--delay': '80ms' } as CSSProperties}>
        <h2>Доходы и расходы</h2>
        <p className="analytics-card-subtitle">Сводка {periodLabel[period]}</p>
        <div className="analytics-metric-grid">
          <div className="analytics-metric">
            <span>Доходы</span>
            <strong className="money positive">{formatVnd(incomeSumVnd)}</strong>
            <em className="money-secondary">{formatUsdFromVnd(incomeSumVnd, usdRateVnd)}</em>
          </div>
          <div className="analytics-metric">
            <span>Расходы</span>
            <strong className="money negative">{formatVnd(expenseSumVnd)}</strong>
            <em className="money-secondary">{formatUsdFromVnd(expenseSumVnd, usdRateVnd)}</em>
          </div>
          <div className="analytics-metric">
            <span>Баланс</span>
            <strong className="money">{formatVnd(balanceVnd)}</strong>
            <em className="money-secondary">{formatUsdFromVnd(balanceVnd, usdRateVnd)}</em>
          </div>
        </div>
        <p className="analytics-tx-count">Операций: {txCount}</p>
      </section>

      <section className="analytics-card appear" style={{ '--delay': '150ms' } as CSSProperties}>
        <h2>Расходы по корзинам</h2>
        <p className="analytics-card-subtitle">Обязательное · Стиль жизни · Капитал</p>
        <div className="analytics-bucket-rows">
          {bucketRows.map(({ key, label, icon }) => {
            const bucket = monthlyState.buckets[key];
            const progress = clampProgress(bucket.allocatedVnd > 0 ? (bucket.spentVnd / bucket.allocatedVnd) * 100 : 0);
            return (
              <div className="analytics-bucket-row" key={key}>
                <div className="analytics-bucket-row-top">
                  <div className="icon-bubble analytics-bucket-icon">
                    <Icon name={icon} />
                  </div>
                  <span className="analytics-bucket-label">{label}</span>
                  <MoneyStack
                    amountVnd={bucket.spentVnd}
                    usdRateVnd={usdRateVnd}
                    className="analytics-bucket-spent"
                  />
                </div>
                <div className="progress-track analytics-progress-track">
                  <i style={{ width: `${progress}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="analytics-card appear" style={{ '--delay': '210ms' } as CSSProperties}>
        <h2>Топ категорий</h2>
        <p className="analytics-card-subtitle">
          {topCategories.length > 0 ? `Расходы ${periodLabel[period]}` : 'Расходы по категориям'}
        </p>
        {topCategories.length === 0 ? (
          <div className="analytics-placeholder-state">
            <div className="analytics-placeholder-icon-wrap">
              <Icon name="tag" />
            </div>
            <span>Пока нет расходов</span>
            <span className="analytics-placeholder-hint">Добавьте расход через кнопку +</span>
          </div>
        ) : (
          <div className="analytics-top-cat-list">
            {topCategories.map((item) => (
              <div className="analytics-top-cat-row" key={item.category}>
                <div className="analytics-top-cat-main">
                  <div className="analytics-top-cat-name-row">
                    <span className="analytics-top-cat-name">{item.category}</span>
                    <span className="analytics-top-cat-pct">{item.sharePercent}%</span>
                  </div>
                  <div className="analytics-top-cat-bar">
                    <i style={{ width: `${item.sharePercent}%` }} />
                  </div>
                  <div className="analytics-top-cat-bottom">
                    <span className="analytics-top-cat-ops">{txOpsLabel(item.count)}</span>
                    <span className="analytics-top-cat-amounts">
                      <strong className="money">{formatVnd(item.totalVnd)}</strong>
                      <em className="money-secondary">{formatUsdFromVnd(item.totalVnd, usdRateVnd)}</em>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="analytics-card appear" style={{ '--delay': '280ms' } as CSSProperties}>
        <h2>Динамика</h2>
        <p className="analytics-card-subtitle">График по дням будет добавлен следующим шагом</p>
        <div className="analytics-sparkline-wrap" aria-hidden="true">
          <svg className="analytics-sparkline" viewBox="0 0 280 56" preserveAspectRatio="none">
            <polyline points="0,48 35,36 70,40 105,26 140,30 175,16 210,20 245,10 280,14" />
          </svg>
        </div>
      </section>
    </section>
  );
}

export default function App() {
  const [savedInitialState] = useState<SavedState>(() => loadSavedState());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [isAuthPreviewPassed, setIsAuthPreviewPassed] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>('local');
  const [cloudError, setCloudError] = useState('');
  const [cloudInitialLoadComplete, setCloudInitialLoadComplete] = useState(false);
  const [monthlyState, setMonthlyState] = useState<MonthlyState>(savedInitialState.monthlyState);
  const [transactions, setTransactions] = useState<Transaction[]>(savedInitialState.transactions);
  const [activeScreen, setActiveScreen] = useState<Screen>('home');
  const [usdRateVnd, setUsdRateVnd] = useState(savedInitialState.usdRateVnd);
  const [usdRateInput, setUsdRateInput] = useState(String(savedInitialState.usdRateVnd));
  const [usdRateUpdatedAt, setUsdRateUpdatedAt] = useState<string | null>(savedInitialState.usdRateUpdatedAt ?? null);
  const [exchangeRateStatus, setExchangeRateStatus] = useState<ExchangeRateStatus>('idle');
  const [exchangeRateError, setExchangeRateError] = useState<string | null>(null);
  const [currencySettings, setCurrencySettings] = useState<CurrencySettings>(savedInitialState.currencySettings);
  const [budgetRule, setBudgetRule] = useState<BudgetRule>(savedInitialState.budgetRule);
  const [activeMonth, setActiveMonth] = useState(savedInitialState.activeMonth);
  const [wallets, setWallets] = useState<Wallet[]>(savedInitialState.wallets);
  const [defaultWalletId, setDefaultWalletId] = useState(savedInitialState.defaultWalletId);
  const [dailySpendDays, setDailySpendDays] = useState(savedInitialState.dailySpendDays);
  const [weekStartDay, setWeekStartDay] = useState<WeekStartDay>(savedInitialState.weekStartDay);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddClosing, setQuickAddClosing] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [customCategories, setCustomCategories] = useState<Record<BucketKey, string[]>>(
    savedInitialState.customCategories,
  );
  const [hiddenCategories, setHiddenCategories] = useState<Record<BucketKey, string[]>>(
    savedInitialState.hiddenCategories,
  );
  const [categoryUsage, setCategoryUsage] = useState<Record<BucketKey, Record<string, number>>>(
    savedInitialState.categoryUsage,
  );
  const [mandatoryPayments, setMandatoryPayments] = useState<MandatoryPayment[]>(
    savedInitialState.mandatoryPayments,
  );
  const [resetPending, setResetPending] = useState(false);
  const [newMonthPending, setNewMonthPending] = useState(false);
  const [backupStatus, setBackupStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const mergedExpenseCategories = getMergedExpenseCategories(expenseCategories, customCategories, hiddenCategories);
  const allExpenseCategoryNames = getAllExpenseCategoryNames(expenseCategories, customCategories, hiddenCategories);
  const walletBalances = useMemo(() => deriveWalletBalances(wallets, transactions, defaultWalletId), [wallets, transactions, defaultWalletId]);
  const dongiBalanceVnd = walletBalances[DEFAULT_WALLET_ID] ?? 0;
  const cryptoIncomeUsd = deriveCryptoMonthlyIncomeUsd(transactions, activeMonth, usdRateVnd);
  const homeData = deriveHomeData(monthlyState, usdRateVnd, budgetRule, activeMonth, dailySpendDays, weekStartDay, dongiBalanceVnd, cryptoIncomeUsd);
  const mandatoryProgress = deriveMandatoryProgress(mandatoryPayments, monthlyState.buckets.needs.allocatedVnd, transactions, activeMonth);
  const rebuiltCategoryUsage = useMemo(() => buildCategoryUsageFromTransactions(transactions), [transactions]);
  const usdRateInputFocusedRef = useRef(false);
  const exchangeRateAutoCheckedRef = useRef(false);
  const hasLocalChangesSinceCloudLoadStartedRef = useRef(false);

  const markLocalDirty = () => {
    if (!cloudInitialLoadComplete) {
      hasLocalChangesSinceCloudLoadStartedRef.current = true;
    }
  };

  const applySavedState = (state: SavedState) => {
    const rebuiltCategoryUsage = buildCategoryUsageFromTransactions(state.transactions);
    setMonthlyState(state.monthlyState);
    setTransactions(state.transactions);
    setUsdRateVnd(state.usdRateVnd);
    setUsdRateInput(String(state.usdRateVnd));
    setUsdRateUpdatedAt(state.usdRateUpdatedAt ?? null);
    setCustomCategories(state.customCategories);
    setHiddenCategories(state.hiddenCategories);
    setCategoryUsage(rebuiltCategoryUsage);
    setMandatoryPayments(state.mandatoryPayments);
    setCurrencySettings(state.currencySettings);
    setBudgetRule(state.budgetRule);
    setActiveMonth(state.activeMonth);
    setWallets(state.wallets);
    setDefaultWalletId(state.defaultWalletId);
    setDailySpendDays(state.dailySpendDays);
    setWeekStartDay(state.weekStartDay);
    setQuickAddOpen(false);
    setQuickAddClosing(false);
    setEditingTransaction(null);
    setResetPending(false);
    setNewMonthPending(false);
  };

  const currentSavedState: SavedState = useMemo(() => ({
    monthlyState,
    transactions,
    usdRateVnd,
    usdRateUpdatedAt,
    customCategories,
    hiddenCategories,
    categoryUsage: rebuiltCategoryUsage,
    mandatoryPayments,
    currencySettings,
    budgetRule,
    activeMonth,
    wallets,
    defaultWalletId,
    dailySpendDays,
    weekStartDay,
  }), [
    monthlyState,
    transactions,
    usdRateVnd,
    usdRateUpdatedAt,
    customCategories,
    hiddenCategories,
    rebuiltCategoryUsage,
    mandatoryPayments,
    currencySettings,
    budgetRule,
    activeMonth,
    wallets,
    defaultWalletId,
    dailySpendDays,
    weekStartDay,
  ]);
  const currentSavedStateRef = useRef(currentSavedState);

  useEffect(() => {
    currentSavedStateRef.current = currentSavedState;
  }, [currentSavedState]);

  useEffect(() => {
    saveState(currentSavedState);
  }, [currentSavedState]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.body.classList.toggle('quick-add-open', quickAddOpen);

    return () => {
      document.body.classList.remove('quick-add-open');
    };
  }, [quickAddOpen]);

  useEffect(() => {
    if (!auth || !db || !isFirebaseConfigured) {
      setFirebaseUser(null);
      setAuthLoading(false);
      setCloudStatus('local');
      setCloudInitialLoadComplete(false);
      return;
    }

    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void authPersistenceReady.finally(() => {
      if (!isMounted || !auth) {
        return;
      }

      unsubscribe = onAuthStateChanged(auth, (user) => {
        if (!isMounted) {
          return;
        }

        setFirebaseUser(user);
        setAuthLoading(false);
        setCloudError('');

        if (user) {
          setIsAuthPreviewPassed(true);
          setCloudInitialLoadComplete(false);
          setCloudStatus('loading');
        } else {
          setCloudInitialLoadComplete(false);
          setCloudStatus('local');
        }
      });

      return unsubscribe;
    });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!firebaseUser || !db) {
      return;
    }

    let isCancelled = false;
    const stateRef = doc(db, 'users', firebaseUser.uid, 'velaBudget', 'state');

    const loadCloudState = async () => {
      hasLocalChangesSinceCloudLoadStartedRef.current = false;
      setCloudStatus('loading');
      setCloudError('');

      try {
        const snapshot = await getDoc(stateRef);

        if (isCancelled) {
          return;
        }

        if (snapshot.exists()) {
          const cloudState = readBackupPayload(snapshot.data());

          if (cloudState) {
            if (hasLocalChangesSinceCloudLoadStartedRef.current) {
              console.info('Skipped initial cloud state because local changes were made during load.');
            } else {
              const localTxCount = currentSavedStateRef.current.transactions.length;
              const cloudTxCount = cloudState.transactions.length;
              if (cloudTxCount >= localTxCount) {
                saveState(cloudState);
                applySavedState(cloudState);
              } else {
                console.info('Kept local state: local has more transactions than cloud.');
              }
            }
            setCloudStatus('synced');
          } else {
            setCloudStatus('error');
            setCloudError('Облачные данные не подходят. Локальная копия сохранена.');
          }
        } else {
          await setDoc(stateRef, {
            data: currentSavedStateRef.current,
            updatedAt: serverTimestamp(),
            app: 'VelaBudget',
            version: 1,
          });

          if (!isCancelled) {
            setCloudStatus('synced');
          }
        }
      } catch (error) {
        if (!isCancelled) {
          setCloudStatus('error');
          setCloudError(error instanceof Error ? error.message : 'Не удалось синхронизировать облако');
        }
      } finally {
        if (!isCancelled) {
          setCloudInitialLoadComplete(true);
        }
      }
    };

    void loadCloudState();

    return () => {
      isCancelled = true;
    };
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser || !db || !cloudInitialLoadComplete) {
      return;
    }

    const firestore = db;
    const saveTimer = window.setTimeout(() => {
      const stateRef = doc(firestore, 'users', firebaseUser.uid, 'velaBudget', 'state');
      setCloudStatus('saving');
      setCloudError('');

      void setDoc(stateRef, {
        data: currentSavedState,
        updatedAt: serverTimestamp(),
        app: 'VelaBudget',
        version: 1,
      })
        .then(() => {
          setCloudStatus('synced');
        })
        .catch((error: unknown) => {
          setCloudStatus('error');
          setCloudError(error instanceof Error ? error.message : 'Не удалось сохранить в облако');
        });
    }, 600);

    return () => window.clearTimeout(saveTimer);
  }, [cloudInitialLoadComplete, currentSavedState, firebaseUser]);

  useEffect(() => {
    setCategoryUsage(buildCategoryUsageFromTransactions(transactions));
  }, [transactions]);

  useEffect(() => {
    setResetPending(false);
    setNewMonthPending(false);
  }, [activeScreen]);

  const addCustomCategory = (bucketKey: BucketKey, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    markLocalDirty();
    setCustomCategories((current) => {
      const allCategories = getAllExpenseCategoryNames(expenseCategories, current, hiddenCategories);
      if (allCategories.some((cat) => cat.toLowerCase() === trimmed.toLowerCase())) {
        return current;
      }
      return { ...current, [bucketKey]: [...current[bucketKey], trimmed] };
    });
  };

  const deleteCustomCategory = (bucketKey: BucketKey, name: string) => {
    markLocalDirty();
    setCustomCategories((current) => ({
      ...current,
      [bucketKey]: current[bucketKey].filter((cat) => cat !== name),
    }));
  };

  const hideCategory = (name: string) => {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return;

    markLocalDirty();
    setHiddenCategories((current) => {
      const next = { ...current };
      for (const bucketKey of ['needs', 'lifestyle', 'capital'] as BucketKey[]) {
        const existsInBucket = [...expenseCategories[bucketKey], ...customCategories[bucketKey]].some(
          (cat) => cat.toLowerCase() === normalized,
        );
        const alreadyHidden = current[bucketKey].some((cat) => cat.toLowerCase() === normalized);

        if (existsInBucket && !alreadyHidden) {
          next[bucketKey] = [...current[bucketKey], name.trim()];
        }
      }
      return next;
    });
  };

  const handleUsdRateInputChange = (value: string) => {
    markLocalDirty();
    const digitsOnly = value.replace(/\D/g, '');
    setUsdRateInput(digitsOnly);
    setExchangeRateStatus('idle');
    setExchangeRateError(null);

    const nextRate = Number(digitsOnly);
    if (Number.isFinite(nextRate) && nextRate > 0) {
      setUsdRateVnd(nextRate);
    }
  };

  const handleUsdRateInputFocusChange = (isFocused: boolean) => {
    usdRateInputFocusedRef.current = isFocused;
  };

  const updateExchangeRate = async (mode: 'manual' | 'auto' = 'manual') => {
    if (mode === 'auto' && usdRateInputFocusedRef.current) {
      return;
    }

    setExchangeRateStatus('loading');
    setExchangeRateError(null);

    try {
      const nextRate = await fetchUsdVndRate();

      if (mode === 'auto' && usdRateInputFocusedRef.current) {
        setExchangeRateStatus('idle');
        return;
      }

      const updatedAt = new Date().toISOString();
      markLocalDirty();
      setUsdRateVnd(nextRate);
      setUsdRateInput(String(nextRate));
      setUsdRateUpdatedAt(updatedAt);
      setExchangeRateStatus('success');
    } catch (error) {
      setExchangeRateStatus('error');
      setExchangeRateError(error instanceof Error ? error.message : 'Не удалось получить курс USD');
    }
  };

  useEffect(() => {
    const canCheckRate = !authLoading && (!firebaseUser || cloudInitialLoadComplete);

    if (!canCheckRate || exchangeRateAutoCheckedRef.current || isTimestampToday(usdRateUpdatedAt)) {
      return;
    }

    exchangeRateAutoCheckedRef.current = true;
    void updateExchangeRate('auto');
  }, [authLoading, cloudInitialLoadComplete, firebaseUser, usdRateUpdatedAt]);

  const applyImportedState = (state: SavedState) => {
    applySavedState(state);
  };

  const handleExportData = () => {
    const exportedAt = new Date().toISOString();
    const backup = {
      app: 'VelaBudget',
      version: 1,
      exportedAt,
      data: currentSavedState,
    };
    const fileDate = formatDateInputValue(new Date());
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `velabudget-backup-${fileDate}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setBackupStatus({ type: 'success', text: 'Файл сохранён' });
  };

  const handleImportFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const importedState = readBackupPayload(parsed);

      if (!importedState) {
        setBackupStatus({ type: 'error', text: 'Файл не подходит' });
        return;
      }

      const normalizedState = {
        ...importedState,
        monthlyState: rebuildMonthlyStateFromTransactions(importedState.transactions, importedState.activeMonth),
        categoryUsage: buildCategoryUsageFromTransactions(importedState.transactions),
      };
      markLocalDirty();
      saveState(normalizedState);
      applyImportedState(normalizedState);
      setBackupStatus({ type: 'success', text: 'Данные импортированы' });
    } catch {
      setBackupStatus({ type: 'error', text: 'Файл не подходит' });
    }
  };

  const scrollToTop = () => requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));

  const openQuickAdd = () => {
    setQuickAddClosing(false);
    setQuickAddOpen(true);
    scrollToTop();
  };

  const handleNavigate = (screen: Screen) => {
    setQuickAddOpen(false);
    setQuickAddClosing(false);
    setActiveScreen(screen);
    scrollToTop();
  };

  const closeQuickAdd = () => {
    setQuickAddClosing(true);
    window.setTimeout(() => {
      setQuickAddOpen(false);
      setQuickAddClosing(false);
    }, 240);
  };

  const handleQuickAddSubmit = (
    mode: 'income' | 'expense',
    amountVnd: number,
    bucketKey: BucketKey,
    category: string,
    createdAt: string,
    walletId: string,
    incomeDistributionMode: 'auto' | 'manual' = 'auto',
    incomeTargetBuckets?: BucketKey[],
  ) => {
    markLocalDirty();
    const transaction: Transaction = {
      id: createTransactionId(),
      type: mode,
      amountVnd,
      usdApprox: Math.round(amountVnd / usdRateVnd),
      budgetRule: mode === 'income' ? budgetRule : undefined,
      bucket: mode === 'expense' ? bucketKey : undefined,
      walletId,
      incomeDistributionMode: mode === 'income' ? incomeDistributionMode : undefined,
      incomeTargetBucket: mode === 'income' && incomeDistributionMode === 'manual' ? incomeTargetBuckets?.[0] ?? 'needs' : undefined,
      incomeTargetBuckets: mode === 'income' && incomeDistributionMode === 'manual' ? incomeTargetBuckets?.filter(isBucketKey) ?? ['needs'] : undefined,
      category,
      createdAt,
    };

    if (isTransactionInActiveMonth(transaction.createdAt, activeMonth)) {
      setMonthlyState((current) => applyTransactionEffect(current, transaction));
    }
    setTransactions((current) => [transaction, ...current]);

    closeQuickAdd();
  };

  const handleTransferSubmit = (amountUsd: number, amountVnd: number, rateVnd: number, createdAt: string) => {
    markLocalDirty();
    const transaction: Transaction = {
      id: createTransactionId(),
      type: 'transfer',
      amountVnd,
      usdApprox: Math.round(amountUsd),
      fromWalletId: 'crypto',
      toWalletId: DEFAULT_WALLET_ID,
      transferRateVnd: rateVnd,
      transferAmountUsd: amountUsd,
      category: 'Крипта → Донги',
      walletId: DEFAULT_WALLET_ID,
      createdAt,
    };
    setTransactions((current) => [transaction, ...current]);
    closeQuickAdd();
  };

  const deleteTransaction = (transactionId: string) => {
    const transaction = transactions.find((item) => item.id === transactionId);

    if (!transaction) {
      return;
    }

    markLocalDirty();
    if (isTransactionInActiveMonth(transaction.createdAt, activeMonth)) {
      setMonthlyState((current) => reverseTransactionEffect(current, transaction));
    }
    setTransactions((current) => current.filter((item) => item.id !== transactionId));
  };

  const addMandatoryPayment = (name: string, amountVnd: number, dueDay: number) => {
    markLocalDirty();
    const payment: MandatoryPayment = {
      id: createTransactionId(),
      name: name.trim(),
      amountVnd,
      dueDay,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    setMandatoryPayments((current) => [...current, payment]);
  };

  const deleteMandatoryPayment = (id: string) => {
    markLocalDirty();
    setMandatoryPayments((current) => current.filter((item) => item.id !== id));
  };

  const toggleMandatoryPayment = (id: string) => {
    markLocalDirty();
    setMandatoryPayments((current) =>
      current.map((item) => (item.id === id ? { ...item, isActive: !item.isActive } : item)),
    );
  };

  const handleResetClick = () => {
    if (resetPending) {
      const cleanState = createCleanSavedState();
      markLocalDirty();
      saveState(cleanState);
      setMonthlyState(cleanState.monthlyState);
      setTransactions(cleanState.transactions);
      setCategoryUsage(cleanState.categoryUsage);
      setCustomCategories(cleanState.customCategories);
      setHiddenCategories(cleanState.hiddenCategories);
      setMandatoryPayments(cleanState.mandatoryPayments);
      setCurrencySettings(cleanState.currencySettings);
      setBudgetRule(cleanState.budgetRule);
      setActiveMonth(cleanState.activeMonth);
      setWallets(cleanState.wallets);
      setDefaultWalletId(cleanState.defaultWalletId);
      setDailySpendDays(cleanState.dailySpendDays);
      setWeekStartDay(cleanState.weekStartDay);
      setUsdRateVnd(cleanState.usdRateVnd);
      setUsdRateInput(String(cleanState.usdRateVnd));
      setUsdRateUpdatedAt(cleanState.usdRateUpdatedAt ?? null);
      setQuickAddOpen(false);
      setQuickAddClosing(false);
      setEditingTransaction(null);
      setResetPending(false);
      setNewMonthPending(false);
    } else {
      setResetPending(true);
      setNewMonthPending(false);
    }
  };

  const handleStartNewMonthClick = () => {
    if (newMonthPending) {
      const nextActiveMonth = getCurrentMonthValue();
      markLocalDirty();
      setMonthlyState(rebuildMonthlyStateFromTransactions(transactions, nextActiveMonth));
      setActiveMonth(nextActiveMonth);
      setQuickAddOpen(false);
      setQuickAddClosing(false);
      setEditingTransaction(null);
      setNewMonthPending(false);
      return;
    }

    setNewMonthPending(true);
    setResetPending(false);
  };

  const editTransaction = (nextTransaction: Transaction) => {
    const currentTransaction = transactions.find((item) => item.id === nextTransaction.id);

    if (!currentTransaction) {
      return;
    }

    markLocalDirty();
    setMonthlyState((current) => {
      const withoutOld = isTransactionInActiveMonth(currentTransaction.createdAt, activeMonth)
        ? reverseTransactionEffect(current, currentTransaction)
        : current;
      return isTransactionInActiveMonth(nextTransaction.createdAt, activeMonth)
        ? applyTransactionEffect(withoutOld, nextTransaction)
        : withoutOld;
    });
    setTransactions((current) => current.map((item) => (item.id === nextTransaction.id ? nextTransaction : item)));
    setEditingTransaction(null);
  };

  const handleGoogleAuth = async () => {
    if (!auth || !isFirebaseConfigured) {
      const message = 'Firebase config не задан. Добавьте VITE_FIREBASE_* значения.';
      setCloudStatus('error');
      setCloudError(message);
      throw new Error(message);
    }

    setAuthLoading(true);
    setCloudStatus('loading');
    setCloudError('');

    try {
      await authPersistenceReady;
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      const canFallbackToRedirect =
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/operation-not-supported-in-this-environment';

      if (canFallbackToRedirect) {
        await signInWithRedirect(auth, googleProvider);
        return;
      }

      setAuthLoading(false);
      setCloudStatus('error');
      setCloudError(error instanceof Error ? error.message : 'Не удалось войти через Google');
      throw error;
    }
  };

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    setFirebaseUser(null);
    setCloudStatus('local');
    setCloudError('');
    setCloudInitialLoadComplete(false);
  };

  if (!isAuthPreviewPassed) {
    return (
      <AuthScreen
        mode={authMode}
        onModeChange={setAuthMode}
        onEnterPreview={() => setIsAuthPreviewPassed(true)}
        onGoogleAuth={handleGoogleAuth}
        authLoading={authLoading}
        cloudError={cloudError}
      />
    );
  }

  return (
    <main className="app-shell">
      <div className="phone-surface">
        {activeScreen === 'home' ? (
          <>
            <header className="hero-header">
              <div>
                <h1>
                  <span>Vela</span>Budget
                </h1>
                <p className="month-label">{homeData.summary.month}</p>
              </div>
            </header>

            <div className="content-stack">
              <BalanceCard data={homeData.summary} />
              <DailyCard data={homeData.summary} usdRateVnd={usdRateVnd} />
              <MandatoryPaymentsCard data={mandatoryProgress} usdRateVnd={usdRateVnd} />
              <BucketCards items={homeData.allocations} usdRateVnd={usdRateVnd} />
            </div>
          </>
        ) : activeScreen === 'history' ? (
          <HistoryScreen
            transactions={transactions}
            usdRateVnd={usdRateVnd}
            activeMonth={activeMonth}
            onDeleteTransaction={deleteTransaction}
            onEditTransaction={setEditingTransaction}
            mandatoryPayments={mandatoryPayments}
            wallets={wallets}
            defaultWalletId={defaultWalletId}
          />
        ) : activeScreen === 'analytics' ? (
          <AnalyticsScreen
            transactions={transactions}
            monthlyState={monthlyState}
            usdRateVnd={usdRateVnd}
            activeMonth={activeMonth}
          />
        ) : (
          <SettingsScreen
            usdRateInput={usdRateInput}
            onUsdRateInputChange={handleUsdRateInputChange}
            onUsdRateInputFocusChange={handleUsdRateInputFocusChange}
            exchangeRateStatus={exchangeRateStatus}
            exchangeRateUpdatedAt={usdRateUpdatedAt}
            exchangeRateError={exchangeRateError}
            onUpdateExchangeRate={() => updateExchangeRate('manual')}
            currencySettings={currencySettings}
            onCurrencySettingsChange={(settings) => {
              markLocalDirty();
              setCurrencySettings(settings);
            }}
            budgetRule={budgetRule}
            onBudgetRuleChange={(rule) => {
              markLocalDirty();
              setBudgetRule(rule);
            }}
            dailySpendDays={dailySpendDays}
            onDailySpendDaysChange={(days) => {
              markLocalDirty();
              setDailySpendDays(readSavedDailySpendDays(days));
            }}
            weekStartDay={weekStartDay}
            onWeekStartDayChange={(day) => {
              markLocalDirty();
              setWeekStartDay(readSavedWeekStartDay(day));
            }}
            mergedExpenseCategories={mergedExpenseCategories}
            allExpenseCategoryNames={allExpenseCategoryNames}
            customCategories={customCategories}
            hiddenCategories={hiddenCategories}
            onAddCustomCategory={addCustomCategory}
            onDeleteCustomCategory={deleteCustomCategory}
            onHideCategory={hideCategory}
            activeMonth={activeMonth}
            backupStatus={backupStatus}
            onExportData={handleExportData}
            onImportFile={handleImportFile}
            resetPending={resetPending}
            onResetClick={handleResetClick}
            mandatoryPayments={mandatoryPayments}
            onAddMandatoryPayment={addMandatoryPayment}
            onDeleteMandatoryPayment={deleteMandatoryPayment}
            onToggleMandatoryPayment={toggleMandatoryPayment}
            firebaseUser={firebaseUser}
            cloudStatus={cloudStatus}
            cloudError={cloudError}
            onGoogleAuth={handleGoogleAuth}
            onSignOut={handleSignOut}
            wallets={wallets}
            defaultWalletId={defaultWalletId}
            walletBalances={walletBalances}
            usdRateVnd={usdRateVnd}
          />
        )}

        {quickAddOpen ? (
          <QuickAddOverlay
            closing={quickAddClosing}
            onClose={closeQuickAdd}
            onSubmit={handleQuickAddSubmit}
            onTransferSubmit={handleTransferSubmit}
            usdRateVnd={usdRateVnd}
            budgetRule={budgetRule}
            activeMonth={activeMonth}
            expenseCategoryOptions={mergedExpenseCategories}
            categoryUsage={categoryUsage}
            mandatoryPayments={mandatoryPayments}
            wallets={wallets}
            defaultWalletId={defaultWalletId}
          />
        ) : null}
        {editingTransaction ? (
          <EditTransactionOverlay
            transaction={editingTransaction}
            usdRateVnd={usdRateVnd}
            expenseCategoryOptions={mergedExpenseCategories}
            categoryUsage={categoryUsage}
            mandatoryPayments={mandatoryPayments}
            onCancel={() => setEditingTransaction(null)}
            onSave={editTransaction}
          />
        ) : null}
      </div>
      <BottomNav activeScreen={activeScreen} onAdd={openQuickAdd} onNavigate={handleNavigate} />
    </main>
  );
}
