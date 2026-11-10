import * as hh from './household';

/**
 * The `manage_household` tool, built for ONE fixed person.
 *
 * The owner's MCP server gets makeHouseholdTool('zvi') (via registry/mega-tools.ts);
 * the roommate's server (ASTRA_PROFILE=household) gets makeHouseholdTool('michal') and
 * nothing else (via registry/household-profile.ts). The actor is closed over here, not
 * a parameter, so the model can't act as the other person: approvals, deletions and
 * "who entered this" are all checked against it in tools/household.ts.
 *
 * Imports only ./household (which imports only ./config) — safe for the roommate's process.
 */

const ACTIONS = [
    'add_expense', 'list_expenses', 'balance', 'settle', 'pending', 'approve', 'reject', 'delete_expense',
    'add_items', 'list_items', 'mark_purchased', 'remove_items', 'monthly_summary',
];

function toIds(v: any): number[] {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
    return arr.map((x: any) => parseInt(String(x).replace(/^#/, ''), 10)).filter((n: number) => Number.isFinite(n));
}

export function makeHouseholdTool(actor: hh.Person) {
    const me = hh.NAME_HE[actor];
    const them = hh.NAME_HE[hh.otherPerson(actor)];
    return {
        name: 'manage_household',
        description:
            `Shared household of ${hh.NAME_HE.zvi} and ${hh.NAME_HE.michal} (roommates): shared expenses split 50/50, ` +
            `who owes whom, settlements, and the house shopping list. You are talking to ${me}; every action is recorded as ${me}. ` +
            "Choose action: 'add_expense' (needs amount + description; optional payer zvi|michal (default: the speaker), " +
            "category groceries|utilities|maintenance|other, bill_type electricity|water|arnona|gas|internet, major_repair, date), " +
            "'list_expenses' (optional month YYYY-MM), 'balance', " +
            "'settle' (a money transfer between them; amount + from_person/to_person, default: the speaker paid the other), " +
            `'pending' (expenses waiting for approval), 'approve' / 'reject' (expense_id; only the person who did NOT enter it — ` +
            `so ${me} can only decide ${them}'s entries), 'delete_expense' (expense_id; own entries only), ` +
            "'add_items' (items: comma-separated, each WITH its quantity, e.g. \"2 חלב 3%, 12 ביצים L\"; items without a " +
            "quantity are refused and must be clarified with the user), 'list_items', " +
            "'mark_purchased' (item_ids, or names, or all=true), 'remove_items' (item_ids), " +
            "'monthly_summary' (optional month YYYY-MM, default the current month). Amounts are ₪. " +
            'Expenses over ₪500, or a plumber/major repair, wait for the other roommate\'s approval before they count.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ACTIONS, description: 'Household operation to perform' },
                amount: { type: 'number', description: 'Shekels (add_expense / settle)' },
                description: { type: 'string', description: 'What the expense was for, in the user\'s words (add_expense)' },
                payer: { type: 'string', enum: hh.PEOPLE, description: 'Who paid (add_expense). Default: the person speaking' },
                category: { type: 'string', enum: hh.CATEGORIES, description: 'Expense category (add_expense). Inferred if omitted' },
                bill_type: { type: 'string', enum: hh.BILL_TYPES, description: 'For a utility bill (add_expense). Inferred if omitted' },
                major_repair: { type: 'boolean', description: 'True for a plumber or major repair: needs the other roommate\'s approval (add_expense)' },
                date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
                from_person: { type: 'string', enum: hh.PEOPLE, description: 'Who transferred the money (settle)' },
                to_person: { type: 'string', enum: hh.PEOPLE, description: 'Who received it (settle)' },
                note: { type: 'string', description: 'Optional note (settle / reject)' },
                expense_id: { type: 'number', description: 'Expense id (approve / reject / delete_expense)' },
                month: { type: 'string', description: 'YYYY-MM (list_expenses / monthly_summary)' },
                items: { type: 'string', description: 'Comma-separated items, each with a quantity (add_items)' },
                item_ids: { type: 'string', description: 'Comma-separated item ids (mark_purchased / remove_items)' },
                names: { type: 'string', description: 'Comma-separated item names (mark_purchased)' },
                all: { type: 'boolean', description: 'Mark every open item as purchased (mark_purchased)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}): Promise<Record<string, any>> => {
            try {
                switch (a.action) {
                    case 'add_expense':
                        return hh.addExpense({
                            actor, amount: a.amount, description: a.description, payer: a.payer, category: a.category,
                            bill_type: a.bill_type, major_repair: a.major_repair, date: a.date,
                        });
                    case 'list_expenses': {
                        const rows = hh.listExpenses(a.month);
                        return { status: 'success', month: a.month || 'latest 30', expenses: rows, balance_text: hh.balanceSentence(hh.currentBalance()) };
                    }
                    case 'balance': {
                        const b = hh.currentBalance();
                        const pending = hh.pendingExpenses();
                        return {
                            status: 'success', balance: b, balance_text: hh.balanceSentence(b),
                            meaning: 'positive = Michal owes Zvi, negative = Zvi owes Michal',
                            pending_not_counted: pending.map(e => ({ id: e.id, description: e.description, amount: e.amount, entered_by: e.created_by })),
                        };
                    }
                    case 'settle':
                        return hh.addSettlement(actor, a.amount, a.from_person, a.to_person, a.note, a.date);
                    case 'pending': {
                        const pending = hh.pendingExpenses();
                        return {
                            status: 'success',
                            waiting_for_you: pending.filter(e => e.created_by !== actor),
                            waiting_for_other: pending.filter(e => e.created_by === actor),
                        };
                    }
                    case 'approve':
                    case 'reject': {
                        const id = toIds(a.expense_id)[0];
                        if (!id) return { status: 'error', error: 'expense_id is required — call pending to find it' };
                        return hh.decideExpense(actor, id, a.action === 'approve', a.note);
                    }
                    case 'delete_expense': {
                        const id = toIds(a.expense_id)[0];
                        if (!id) return { status: 'error', error: 'expense_id is required' };
                        return hh.deleteExpense(actor, id);
                    }
                    case 'add_items':
                        return hh.addShoppingItems(actor, a.items || '');
                    case 'list_items': {
                        const items = hh.listShopping('pending');
                        return { status: 'success', count: items.length, items: items.map(i => ({ id: i.id, item: i.item_name, quantity: i.quantity, added_by: hh.NAME_HE[i.added_by] })) };
                    }
                    case 'mark_purchased': {
                        const names = a.names ? String(a.names).split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                        return hh.markPurchased(actor, toIds(a.item_ids), names, !!a.all);
                    }
                    case 'remove_items':
                        return hh.removeItems(toIds(a.item_ids));
                    case 'monthly_summary': {
                        const month = /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : hh.localDate().slice(0, 7);
                        return { status: 'success', summary_text: hh.buildMonthlyDigest(month), data: hh.monthSummary(month) };
                    }
                    default:
                        return { status: 'error', error: `Unknown action "${a.action}". Valid actions: ${ACTIONS.join(', ')}.` };
                }
            } catch (err: any) {
                return { status: 'error', error: String(err?.message || err).slice(0, 300) };
            }
        },
    };
}
