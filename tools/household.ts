import Database from 'better-sqlite3';
import { config } from './config';

/**
 * Household store — shared expenses, settlements and the house shopping list for the
 * owner (Zvi) and his roommate (Michal). See docs/HOUSEHOLD.md.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHY THIS IS NOT IN storage.ts                                    │
 * │                                                                    │
 * │  The roommate's MCP process (ASTRA_PROFILE=household) imports this │
 * │  module and nothing from the owner side. storage.ts opens the      │
 * │  owner's tasks, expenses and schedules; keeping the household on   │
 * │  its own handle means her session has no code path to his data.   │
 * │  Same pattern as nutrition-store.ts.                               │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * WHO is acting is never chosen by the model: each MCP process is pinned to one person
 * (the owner server acts as 'zvi', the household server as 'michal'), and the tool layer
 * passes that identity in. Messages to the two people are queued in `household_outbox`
 * with recipients set here in code, and the scheduler delivers them. This process has no
 * way to send anything itself.
 */

export type Person = 'zvi' | 'michal';
export const PEOPLE: Person[] = ['zvi', 'michal'];
export const NAME_HE: Record<Person, string> = { zvi: 'צבי', michal: 'מיכל' };
export const otherPerson = (p: Person): Person => (p === 'zvi' ? 'michal' : 'zvi');
export function isPerson(v: any): v is Person { return v === 'zvi' || v === 'michal'; }

export type Category = 'groceries' | 'utilities' | 'maintenance' | 'other';
export const CATEGORIES: Category[] = ['groceries', 'utilities', 'maintenance', 'other'];
export const CATEGORY_HE: Record<Category, string> = {
    groceries: 'מכולת וסופר', utilities: 'חשבונות', maintenance: 'תחזוקה ותיקונים', other: 'אחר',
};

export type BillType = 'electricity' | 'water' | 'arnona' | 'gas' | 'internet';
export const BILL_TYPES: BillType[] = ['electricity', 'water', 'arnona', 'gas', 'internet'];
export const BILL_HE: Record<BillType, string> = {
    electricity: 'חשמל', water: 'מים', arnona: 'ארנונה', gas: 'גז', internet: 'אינטרנט',
};

export type ExpenseStatus = 'approved' | 'pending_approval' | 'rejected';

export interface Expense {
    id: number; payer: Person; amount: number; category: Category; description: string;
    date: string; status: ExpenseStatus; created_by: Person; bill_type: BillType | null;
    decided_by: Person | null; decided_at: string | null; decision_note: string | null; created_at: string;
}
export interface Settlement {
    id: number; from_person: Person; to_person: Person; amount: number; date: string; note: string | null; created_by: Person;
}
export interface ShoppingItem {
    id: number; item_name: string; quantity: string; status: 'pending' | 'purchased';
    added_by: Person; created_at: string; purchased_at: string | null; purchased_by: Person | null;
}

// ─── Schema ───────────────────────────────────────────────────────────

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS household_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payer TEXT NOT NULL CHECK (payer IN ('zvi','michal')),
        amount REAL NOT NULL CHECK (amount > 0),
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,                 -- local YYYY-MM-DD
        status TEXT NOT NULL CHECK (status IN ('approved','pending_approval','rejected')),
        created_by TEXT NOT NULL CHECK (created_by IN ('zvi','michal')),
        bill_type TEXT,
        decided_by TEXT,
        decided_at DATETIME,
        decision_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS household_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_person TEXT NOT NULL CHECK (from_person IN ('zvi','michal')),
        to_person TEXT NOT NULL CHECK (to_person IN ('zvi','michal')),
        amount REAL NOT NULL CHECK (amount > 0),
        date TEXT NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS household_shopping_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        quantity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','purchased')),
        added_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        purchased_at DATETIME,
        purchased_by TEXT
    );

    -- Messages for the two people, delivered by the scheduler (quiet hours respected).
    CREATE TABLE IF NOT EXISTS household_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL CHECK (recipient IN ('zvi','michal')),
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | expired | dropped
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS household_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_household_expenses_date ON household_expenses(date);
    CREATE INDEX IF NOT EXISTS idx_household_outbox_status ON household_outbox(status);
`);

// ─── Time helpers ─────────────────────────────────────────────────────

/** Local YYYY-MM-DD in the configured timezone. */
export function localDate(d: Date = new Date()): string {
    return d.toLocaleDateString('sv-SE', { timeZone: config.timezone });
}
const monthOf = (date: string) => date.slice(0, 7);

/** 'YYYY-MM' of the month before the given one. */
export function previousMonth(month: string): string {
    let [y, m] = month.split('-').map(Number);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
}

export function hebrewMonthName(month: string): string {
    const d = new Date(`${month}-15T12:00:00Z`);
    return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const nis = (n: number) => `₪${Math.round(n).toLocaleString('en-US')}`;

// ─── Pure rules (unit-tested in scripts/test-household.js) ────────────

/**
 * How much Michal owes Zvi (negative ⇒ Zvi owes Michal). Shared expenses are split
 * 50/50, so each approved expense moves the balance by half its amount; a settlement
 * moves it by its full amount. Only approved expenses count.
 */
export function computeBalance(expenses: Pick<Expense, 'payer' | 'amount' | 'status'>[], settlements: Pick<Settlement, 'from_person' | 'to_person' | 'amount'>[]): number {
    let paidDiff = 0; // zvi paid − michal paid
    for (const e of expenses) {
        if (e.status !== 'approved') continue;
        paidDiff += e.payer === 'zvi' ? e.amount : -e.amount;
    }
    let balance = paidDiff / 2;
    for (const s of settlements) {
        if (s.from_person === s.to_person) continue;
        // Michal paying Zvi reduces what she owes; Zvi paying Michal increases it.
        balance += s.from_person === 'michal' ? -s.amount : s.amount;
    }
    return Math.round(balance * 100) / 100;
}

/**
 * Should a balance change alert both people? Yes when the debt goes past the threshold,
 * flips direction while past it, or grows by another full threshold (₪800, ₪1,200…).
 * A debt that just sits above the threshold doesn't re-alert on every grocery run.
 */
export function shouldAlertBalance(prev: number, next: number, threshold: number): boolean {
    const level = (b: number) => (Math.abs(b) > threshold ? Math.floor(Math.abs(b) / threshold) : 0);
    if (level(next) === 0) return false;
    if (Math.sign(prev) !== Math.sign(next) && prev !== 0) return true;
    return level(next) > level(prev);
}

const PLUMBER_RE = /אינסטלטור|שרברב|plumb|תיקון\s*גדול|major\s*repair/i;

/** A single expense above the threshold, or a plumber/major repair, waits for approval. */
export function needsApproval(amount: number, description: string, majorRepair: boolean, threshold: number): boolean {
    return amount > threshold || majorRepair || PLUMBER_RE.test(description || '');
}

const BILL_RE: [BillType, RegExp][] = [
    ['electricity', /חשמל|electric/i],
    ['water', /(^|[\sו])מים($|\s)|תאגיד\s*המים|water/i],
    ['arnona', /ארנונה|arnona|municipal\s*tax/i],
    ['gas', /(^|[\sו])גז($|\s)|\bgas\b/i],
    ['internet', /אינטרנט|internet|בזק|hot\b|הוט|פרטנר|סלקום|wifi/i],
];

export function detectBillType(description: string): BillType | null {
    for (const [t, re] of BILL_RE) if (re.test(description || '')) return t;
    return null;
}

const SUPERMARKET_RE = /שופרסל|רמי\s*לוי|יוחננוף|ויקטורי|אושר\s*עד|מגה|טיב\s*טעם|חצי\s*חינם|יינות\s*ביתן|סופר|מכולת|קניות|am:?pm|supermarket|grocer/i;
const MAINTENANCE_RE = /תיקון|אינסטלטור|שרברב|חשמלאי|טכנאי|נזילה|repair|plumb|fix/i;

export function inferCategory(description: string, billType: BillType | null): Category {
    if (billType) return 'utilities';
    if (SUPERMARKET_RE.test(description || '')) return 'groceries';
    if (MAINTENANCE_RE.test(description || '')) return 'maintenance';
    return 'other';
}

export function isSupermarketExpense(category: string, description: string): boolean {
    return category === 'groceries' || SUPERMARKET_RE.test(description || '');
}

// ─── Shopping-list parsing ────────────────────────────────────────────

export interface ParsedItem { name: string; quantity: string | null; }

const UNITS = [
    'יחידות', "יח'", 'יח', 'קופסאות', 'קופסה', 'קופסת', 'בקבוקים', 'בקבוק', 'חבילות', 'חבילה', 'חבילת',
    'ק"ג', 'קג', 'קילו', 'גרם', 'ליטרים', 'ליטר', 'שקיות', 'שקית', 'קרטונים', 'קרטון', 'מגשים', 'מגש',
    'שישיות', 'שישייה', 'שישיית', 'זוגות', 'זוג', 'גלילים', 'גליל', 'kg', 'g', 'l', 'pcs', 'x',
];
const UNIT_ALT = UNITS.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
// Construct forms ("חבילת חלב") → the plain unit for the stored quantity.
const UNIT_NORMAL: Record<string, string> = { 'קופסת': 'קופסה', 'חבילת': 'חבילה', 'שישיית': 'שישייה' };
const NUMBER_WORDS: Record<string, number> = {
    'אחד': 1, 'אחת': 1, 'שני': 2, 'שתי': 2, 'שניים': 2, 'שתיים': 2, 'שלוש': 3, 'שלושה': 3,
    'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5, 'שש': 6, 'שישה': 6, 'שבע': 7, 'שבעה': 7,
    'שמונה': 8, 'תשע': 9, 'תשעה': 9, 'עשר': 10, 'עשרה': 10,
};
const NUM_WORD_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');

const LEAD_NUM = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALT})?\\s+(.+)$`, 'i');
const LEAD_WORD = new RegExp(`^(${NUM_WORD_ALT})\\s+(?:(${UNIT_ALT})\\s+)?(.+)$`);
const LEAD_UNIT = new RegExp(`^(${UNIT_ALT})\\s+(.+)$`);
const TRAIL_NUM = new RegExp(`^(.+?)\\s+[x×]?\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALT})?$`, 'i');
const TRAIL_X = /^(.+?)\s*[x×]\s*(\d+)$/i;

function fmtQty(n: string | number, unit?: string | null): string {
    const u = unit ? (UNIT_NORMAL[unit] || unit) : '';
    return u ? `${n} ${u}` : String(n);
}

/** Parse one item phrase. quantity=null means the user didn't say how much. */
export function parseShoppingItem(raw: string): ParsedItem {
    const s = raw.replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
    let m: RegExpMatchArray | null;
    if ((m = s.match(LEAD_NUM))) return { name: m[3].trim(), quantity: fmtQty(m[1].replace(',', '.'), m[2]) };
    if ((m = s.match(LEAD_WORD))) return { name: m[3].trim(), quantity: fmtQty(NUMBER_WORDS[m[1]], m[2]) };
    if ((m = s.match(LEAD_UNIT))) return { name: m[2].trim(), quantity: fmtQty(1, m[1]) };
    if ((m = s.match(TRAIL_X))) return { name: m[1].trim(), quantity: m[2] };
    // A trailing number counts as a quantity unless it's part of the product (3%, 500 גרם is a unit).
    if ((m = s.match(TRAIL_NUM)) && !/%$/.test(s)) return { name: m[1].trim(), quantity: fmtQty(m[2].replace(',', '.'), m[3]) };
    return { name: s, quantity: null };
}

/** Split a comma/newline-separated list and parse each item. Empty parts are dropped. */
export function parseShoppingItems(text: string): ParsedItem[] {
    return String(text || '')
        .split(/[,\n;،]+/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(parseShoppingItem)
        .filter(i => i.name.length > 0);
}

// ─── Settings + outbox ────────────────────────────────────────────────

export function getSetting(key: string, fallback = ''): string {
    const r = db.prepare('SELECT value FROM household_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : fallback;
}
export function setSetting(key: string, value: string): void {
    db.prepare('INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Queue a message. Nothing is queued while the household feature is off, so turning
 *  it on later doesn't release a backlog. Returns whether it was queued. */
export function queueMessage(recipient: Person, kind: string, text: string): boolean {
    if (!config.household.enabled) return false;
    db.prepare('INSERT INTO household_outbox (recipient, kind, text) VALUES (?, ?, ?)').run(recipient, kind, text);
    return true;
}
export function queueForBoth(kind: string, text: string): boolean {
    const a = queueMessage('zvi', kind, text);
    const b = queueMessage('michal', kind, text);
    return a && b;
}

export interface OutboxRow { id: number; recipient: Person; kind: string; text: string; attempts: number; created_at: string; }

export function getPendingOutbox(): OutboxRow[] {
    return db.prepare("SELECT id, recipient, kind, text, attempts, created_at FROM household_outbox WHERE status = 'pending' ORDER BY id").all() as OutboxRow[];
}
export function markOutbox(id: number, status: 'sent' | 'failed' | 'expired' | 'dropped' | 'pending', error?: string): void {
    db.prepare(`UPDATE household_outbox SET status = ?, attempts = attempts + ?, last_error = ?,
                sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id = ?`)
        .run(status, status === 'expired' ? 0 : 1, error || null, status, id);
}

// ─── Reads ────────────────────────────────────────────────────────────

function allExpenses(): Expense[] {
    return db.prepare('SELECT * FROM household_expenses ORDER BY date, id').all() as Expense[];
}
function allSettlements(): Settlement[] {
    return db.prepare('SELECT * FROM household_settlements ORDER BY date, id').all() as Settlement[];
}
export function currentBalance(): number {
    return computeBalance(allExpenses(), allSettlements());
}
export function getExpense(id: number): Expense | undefined {
    return db.prepare('SELECT * FROM household_expenses WHERE id = ?').get(id) as Expense | undefined;
}
export function listExpenses(month?: string): Expense[] {
    if (month) return db.prepare("SELECT * FROM household_expenses WHERE substr(date,1,7) = ? AND status != 'rejected' ORDER BY date, id").all(month) as Expense[];
    return db.prepare("SELECT * FROM household_expenses WHERE status != 'rejected' ORDER BY date DESC, id DESC LIMIT 30").all() as Expense[];
}
export function pendingExpenses(): Expense[] {
    return db.prepare("SELECT * FROM household_expenses WHERE status = 'pending_approval' ORDER BY id").all() as Expense[];
}
export function listShopping(status: 'pending' | 'purchased' = 'pending'): ShoppingItem[] {
    return db.prepare('SELECT * FROM household_shopping_list WHERE status = ? ORDER BY id').all(status) as ShoppingItem[];
}

// ─── Wording ──────────────────────────────────────────────────────────

/** "מיכל חייבת לצבי ₪450" / "צבי חייב למיכל ₪120" / "אתם מאוזנים". */
export function balanceSentence(balance: number): string {
    if (Math.abs(balance) < 1) return 'אתם מאוזנים, אף אחד לא חייב לאף אחד';
    return balance > 0
        ? `${NAME_HE.michal} חייבת ל${NAME_HE.zvi} ${nis(balance)}`
        : `${NAME_HE.zvi} חייב ל${NAME_HE.michal} ${nis(-balance)}`;
}

export function balanceAlertText(balance: number): string {
    return `🏠 *יתרת הבית עברה ${nis(config.household.balanceAlertThreshold)}*\n\n${balanceSentence(balance)}.\n` +
        'כדאי להתחשבן. אחרי ההעברה, כתבו לאסטרה "העברתי …" כדי לעדכן.';
}

function approvalRequestText(e: Expense): string {
    const who = NAME_HE[e.created_by];
    const payer = e.payer === e.created_by ? '' : ` (שילם/ה: ${NAME_HE[e.payer]})`;
    return `🏠 *הוצאה גדולה מחכה לאישור שלך*\n\n${who} רשם/ה הוצאה #${e.id}: ${e.description} — ${nis(e.amount)}${payer}.\n` +
        'היא לא נכנסת ליתרה עד שתאשר/י. כתבו לאסטרה "מאשר/ת" או "לא מאשר/ת".';
}

// ─── Writes ───────────────────────────────────────────────────────────

/** After any balance change: queue an alert to both if it crossed a threshold step. */
function afterBalanceChange(prev: number): { balance: number; alert_sent_to_both: boolean } {
    const next = currentBalance();
    let alerted = false;
    if (shouldAlertBalance(prev, next, config.household.balanceAlertThreshold)) {
        alerted = queueForBoth('balance_alert', balanceAlertText(next));
    }
    return { balance: next, alert_sent_to_both: alerted };
}

export interface AddExpenseInput {
    actor: Person; amount: number; description: string; payer?: Person; category?: string;
    bill_type?: string; major_repair?: boolean; date?: string;
}

export function addExpense(input: AddExpenseInput): Record<string, any> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        return { status: 'error', error: 'amount must be a positive number of shekels' };
    }
    const description = String(input.description || '').trim();
    if (!description) return { status: 'error', error: 'description is required' };
    const payer: Person = input.payer && isPerson(input.payer) ? input.payer : input.actor;
    const billType: BillType | null = BILL_TYPES.includes(input.bill_type as BillType)
        ? (input.bill_type as BillType) : detectBillType(description);
    const category: Category = CATEGORIES.includes(input.category as Category)
        ? (input.category as Category) : inferCategory(description, billType);
    const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : localDate();
    const pending = needsApproval(amount, description, !!input.major_repair, config.household.approvalThreshold);

    const prev = currentBalance();
    const info = db.prepare(
        `INSERT INTO household_expenses (payer, amount, category, description, date, status, created_by, bill_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(payer, amount, category, description, date, pending ? 'pending_approval' : 'approved', input.actor, billType);
    const expense = getExpense(Number(info.lastInsertRowid))!;

    const out: Record<string, any> = { status: 'success', expense };
    if (pending) {
        const approver = otherPerson(input.actor);
        out.pending_approval = true;
        out.approval_requested_from = NAME_HE[approver];
        out.approval_request_queued = queueMessage(approver, 'approval_request', approvalRequestText(expense));
        out.balance = prev;
        out.balance_text = balanceSentence(prev);
        out.note = `Over ${nis(config.household.approvalThreshold)} or a plumber/major repair: it does NOT count in the balance until ${NAME_HE[approver]} approves.`;
    } else {
        const r = afterBalanceChange(prev);
        out.balance = r.balance;
        out.balance_text = balanceSentence(r.balance);
        out.balance_alert_sent_to_both = r.alert_sent_to_both;
    }
    if (isSupermarketExpense(category, description)) {
        const open = listShopping('pending');
        if (open.length) {
            out.shopping_list_open_items = open.map(i => ({ id: i.id, item: i.item_name, quantity: i.quantity }));
            out.suggestion = 'This looks like a supermarket run. Offer to mark items on the house shopping list as purchased; mark only the ones the user confirms.';
        }
    }
    if (!config.household.enabled && pending) out.delivery_note = 'Household messages are turned off (HOUSEHOLD_ENABLED), so no one was notified.';
    return out;
}

export function decideExpense(actor: Person, id: number, approve: boolean, note?: string): Record<string, any> {
    const e = getExpense(Number(id));
    if (!e) return { status: 'error', error: `No household expense #${id}` };
    if (e.status !== 'pending_approval') return { status: 'error', error: `Expense #${id} is not waiting for approval (status: ${e.status})` };
    if (e.created_by === actor) {
        return { status: 'error', error: `Expense #${id} was entered by you; only ${NAME_HE[otherPerson(actor)]} can approve or reject it.` };
    }
    const prev = currentBalance();
    db.prepare(`UPDATE household_expenses SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ? WHERE id = ?`)
        .run(approve ? 'approved' : 'rejected', actor, note || null, e.id);
    const verdict = approve ? 'אישר/ה' : 'לא אישר/ה';
    queueMessage(e.created_by, 'approval_result',
        `🏠 ${NAME_HE[actor]} ${verdict} את ההוצאה #${e.id}: ${e.description} — ${nis(e.amount)}.` +
        (note ? `\nהערה: ${note}` : '') + (approve ? '' : '\nהיא לא נכנסת ליתרה.'));
    if (!approve) return { status: 'success', expense: getExpense(e.id), balance: prev, balance_text: balanceSentence(prev) };
    const r = afterBalanceChange(prev);
    return { status: 'success', expense: getExpense(e.id), balance: r.balance, balance_text: balanceSentence(r.balance), balance_alert_sent_to_both: r.alert_sent_to_both };
}

export function deleteExpense(actor: Person, id: number): Record<string, any> {
    const e = getExpense(Number(id));
    if (!e || e.status === 'rejected') return { status: 'error', error: `No household expense #${id}` };
    if (e.created_by !== actor) return { status: 'error', error: `Only ${NAME_HE[e.created_by]}, who entered expense #${id}, can delete it.` };
    const prev = currentBalance();
    db.prepare('DELETE FROM household_expenses WHERE id = ?').run(e.id);
    // Deleting changes the shared balance, so the other person hears about it.
    queueMessage(otherPerson(actor), 'expense_deleted', `🏠 ${NAME_HE[actor]} מחק/ה את ההוצאה #${e.id}: ${e.description} — ${nis(e.amount)}.`);
    const r = afterBalanceChange(prev);
    return { status: 'success', deleted: e, balance: r.balance, balance_text: balanceSentence(r.balance) };
}

export function addSettlement(actor: Person, amount: number, from?: string, to?: string, note?: string, date?: string): Record<string, any> {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 100000) return { status: 'error', error: 'amount must be a positive number of shekels' };
    const fromP: Person = isPerson(from) ? from : (isPerson(to) ? otherPerson(to) : actor);
    const toP: Person = isPerson(to) ? to : otherPerson(fromP);
    if (fromP === toP) return { status: 'error', error: 'from_person and to_person must be different people' };
    const prev = currentBalance();
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate();
    db.prepare('INSERT INTO household_settlements (from_person, to_person, amount, date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fromP, toP, amt, d, note || null, actor);
    queueMessage(otherPerson(actor), 'settlement',
        `🏠 ${NAME_HE[actor]} רשם/ה העברה: ${NAME_HE[fromP]} → ${NAME_HE[toP]} ${nis(amt)}.`);
    const r = afterBalanceChange(prev);
    return { status: 'success', settlement: { from: fromP, to: toP, amount: amt, date: d, note: note || null }, balance: r.balance, balance_text: balanceSentence(r.balance), balance_alert_sent_to_both: r.alert_sent_to_both };
}

export function addShoppingItems(actor: Person, text: string): Record<string, any> {
    const parsed = parseShoppingItems(text);
    if (!parsed.length) return { status: 'error', error: 'No items given' };
    const open = listShopping('pending');
    const added: any[] = [], already: any[] = [], unclear: string[] = [];
    const ins = db.prepare('INSERT INTO household_shopping_list (item_name, quantity, added_by) VALUES (?, ?, ?)');
    for (const p of parsed) {
        if (!p.quantity) { unclear.push(p.name); continue; }
        const dup = open.find(o => o.item_name.trim() === p.name);
        if (dup) { already.push({ id: dup.id, item: dup.item_name, quantity: dup.quantity }); continue; }
        const info = ins.run(p.name, p.quantity, actor);
        added.push({ id: Number(info.lastInsertRowid), item: p.name, quantity: p.quantity });
    }
    const out: Record<string, any> = { status: added.length ? 'success' : (unclear.length ? 'needs_clarification' : 'success'), added, already_on_list: already };
    if (unclear.length) {
        out.needs_clarification = unclear;
        out.ask_user = `NOT added: ${unclear.join(', ')}. Ask how many and which kind (e.g. "כמה ${unclear[0]} ואיזה סוג?"), then call add_items again with the answer.`;
    }
    return out;
}

/** Mark items purchased by id, by name match, or all of them. */
export function markPurchased(actor: Person, ids?: number[], names?: string[], all?: boolean): Record<string, any> {
    const open = listShopping('pending');
    const targets = all ? open : open.filter(i =>
        (ids || []).map(Number).includes(i.id) ||
        (names || []).some(n => n && (i.item_name.includes(n.trim()) || n.trim().includes(i.item_name))));
    if (!targets.length) return { status: 'error', error: 'None of those items is on the open list', open_items: open.map(i => ({ id: i.id, item: i.item_name, quantity: i.quantity })) };
    const upd = db.prepare("UPDATE household_shopping_list SET status = 'purchased', purchased_at = CURRENT_TIMESTAMP, purchased_by = ? WHERE id = ?");
    db.transaction(() => { for (const t of targets) upd.run(actor, t.id); })();
    return { status: 'success', marked_purchased: targets.map(t => t.item_name), still_open: listShopping('pending').map(i => ({ id: i.id, item: i.item_name, quantity: i.quantity })) };
}

export function removeItems(ids: number[]): Record<string, any> {
    const del = db.prepare("DELETE FROM household_shopping_list WHERE id = ? AND status = 'pending'");
    let n = 0;
    db.transaction(() => { for (const id of ids || []) n += del.run(Number(id)).changes; })();
    return { status: n ? 'success' : 'error', removed: n, ...(n ? {} : { error: 'No open items with those ids' }) };
}

// ─── Reports (deterministic — used by the tools and the scheduler) ────

export function monthSummary(month: string) {
    const rows = listExpenses(month).filter(e => e.status === 'approved');
    const byCategory: Record<Category, number> = { groceries: 0, utilities: 0, maintenance: 0, other: 0 };
    const byPayer: Record<Person, number> = { zvi: 0, michal: 0 };
    let total = 0;
    for (const e of rows) {
        total += e.amount;
        byCategory[(CATEGORIES.includes(e.category) ? e.category : 'other') as Category] += e.amount;
        byPayer[e.payer] += e.amount;
    }
    const pending = pendingExpenses();
    return { month, total, count: rows.length, byCategory, byPayer, balance: currentBalance(), pending };
}

export function buildMonthlyDigest(month: string): string {
    const s = monthSummary(month);
    const L = [`🏠 *סיכום הוצאות הבית — ${hebrewMonthName(month)}*`, ''];
    L.push(`💸 סך הכל הוצאות משותפות: *${nis(s.total)}* (${s.count} הוצאות)`);
    L.push('', '📊 *לפי קטגוריה:*');
    for (const c of CATEGORIES) {
        if (c === 'other' && s.byCategory.other === 0) continue;
        L.push(`• ${CATEGORY_HE[c]}: ${nis(s.byCategory[c])}`);
    }
    L.push('', '👥 *מי שילם:*');
    for (const p of PEOPLE) L.push(`• ${NAME_HE[p]}: ${nis(s.byPayer[p])}`);
    L.push('', `⚖️ *יתרה לחודש החדש:* ${balanceSentence(s.balance)}`);
    if (s.pending.length) {
        const sum = s.pending.reduce((a, e) => a + e.amount, 0);
        L.push(`⏳ ממתינות לאישור: ${s.pending.length} (${nis(sum)}), לא כלולות ביתרה.`);
    }
    return L.join('\n');
}

/** Bills expected this month (per config) with nothing logged for them yet. */
export function missingBills(dateStr: string): BillType[] {
    const month = monthOf(dateStr);
    const m = Number(month.slice(5, 7));
    const expected = (Object.keys(config.household.billMonths) as BillType[]).filter(t =>
        String(config.household.billMonths[t] || '').split(',').map(x => parseInt(x.trim(), 10)).includes(m));
    if (!expected.length) return [];
    const logged = new Set((db.prepare(
        "SELECT DISTINCT bill_type FROM household_expenses WHERE substr(date,1,7) = ? AND status != 'rejected' AND bill_type IS NOT NULL",
    ).all(month) as { bill_type: string }[]).map(r => r.bill_type));
    return expected.filter(t => !logged.has(t));
}

export function billReminderText(missing: BillType[]): string {
    return `🏠 לא נרשם תשלום ${missing.map(t => BILL_HE[t]).join('/')} החודש, תרצו שאזין סכום?`;
}

// ─── Scheduler entry points (self-gating, once per month) ─────────────

/** 1st of the month or the first day after it that the job runs (quiet hours can push
 *  it), up to the 7th. Queues the digest for both. */
export function runMonthlyDigestJob(dateStr: string): 'queued' | 'skipped' {
    const day = Number(dateStr.slice(8, 10));
    const month = monthOf(dateStr);
    if (day > 7 || getSetting('digest.last_month') === month) return 'skipped';
    const queued = queueForBoth('monthly_digest', buildMonthlyDigest(previousMonth(month)));
    if (!queued) return 'skipped';
    setSetting('digest.last_month', month);
    return 'queued';
}

export function runBillCheckJob(dateStr: string): 'queued' | 'skipped' {
    const day = Number(dateStr.slice(8, 10));
    const month = monthOf(dateStr);
    if (day < config.household.billCheckDay || getSetting('bills.last_month') === month) return 'skipped';
    const missing = missingBills(dateStr);
    setSetting('bills.last_month', month);
    if (!missing.length) return 'skipped';
    return queueForBoth('bill_reminder', billReminderText(missing)) ? 'queued' : 'skipped';
}

export function closeHouseholdDb(): void { db.close(); }
