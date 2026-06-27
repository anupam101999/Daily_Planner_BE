import { pool } from "../config/database.js";

const defaultQuoteProvider = "nse";
const allowedQuoteProviders = new Set(["nse", "screener"]);

export async function getFinanceSettings() {
  const result = await pool.query(
    `select finance_quote_provider as "financeQuoteProvider"
       from daily_setting
      where id = 'shared_dashboard'`,
  );
  return normalizeFinanceSettings(result.rows[0] || {});
}

export async function saveFinanceSettings(settings) {
  const financeQuoteProvider = normalizeQuoteProvider(settings.financeQuoteProvider);
  let result = await pool.query(
    `update daily_setting
        set finance_quote_provider = $1, updated_at = now()
      where id = 'shared_dashboard'
      returning finance_quote_provider as "financeQuoteProvider"`,
    [financeQuoteProvider],
  );
  if (!result.rowCount) {
    result = await pool.query(
      `insert into daily_setting (id, finance_quote_provider, updated_at)
       values ('shared_dashboard', $1, now())
       returning finance_quote_provider as "financeQuoteProvider"`,
      [financeQuoteProvider],
    );
  }
  return normalizeFinanceSettings(result.rows[0] || {});
}

export function normalizeQuoteProvider(value) {
  const provider = String(value || defaultQuoteProvider).trim().toLowerCase();
  return allowedQuoteProviders.has(provider) ? provider : defaultQuoteProvider;
}

function normalizeFinanceSettings(row) {
  return {
    financeQuoteProvider: normalizeQuoteProvider(row.financeQuoteProvider),
    quoteProviders: [
      { id: "nse", label: "NSE" },
      { id: "screener", label: "Screener" },
    ],
  };
}
