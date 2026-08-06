import { config } from '../config';
import { taskTools } from '../tasks';
import { recurringTaskTools } from '../recurring-tasks';
import { expenseTools } from '../expenses';
import { budgetTools } from '../budget';
import { calendarTools } from '../calendar';
import { habitTools } from '../habits';
import { dailyStatusTools } from '../daily-status';
import { memoryTools } from '../memory';
import { whatsappMediaTools } from '../whatsapp-media';
import { voiceTools } from '../voice';
import { notesTools } from '../notes';
// ─── DISABLED from the chat surface 2026-07-06 to shrink the system prompt
//     (faster cold-prefill on the local 8B model). The domain tool logic is
//     fully intact in ../email, ../email-digest, ../immich, ../spotify — only
//     the chat routing below is switched off. To RE-ENABLE: uncomment these
//     imports, the matching HELP_META entries, and the manage_email /
//     manage_photos / manage_music blocks, then `npm run build` + restore the
//     matching skills. The 17:00 email digest + any music_alarm scheduler jobs
//     do NOT use these wrappers (they require() the compiled dist directly), so
//     they are unaffected by this trim.
// import { emailTools } from '../email';
// import { emailDigestTools } from '../email-digest';
// import { immichTools } from '../immich';
import { spotifyTools } from '../spotify';   // RE-ENABLED 2026-08-06 (manage_music)

/**
 * Mega-Tools — consolidated tool surface for the local 8B model.
 *
 * WHY: Hermes-3 8B (and small local models generally) degrade badly when the
 * system prompt carries ~34 individual tool schemas — the prompt overflows the
 * context window and the model loops on hallucinated calls. This module folds
 * the 34 domain tools behind 8 "mega-tools", each dispatched by an explicit
 * `action` enum with a small set of *flat, explicitly-named* parameters.
 *
 * Design rules (do not regress these):
 *   - Always an `action` string enum as the discriminator. Required, first.
 *   - All other params are flat and explicitly named — NEVER a nested `args`
 *     object and NEVER `additionalProperties: true`. 8B models cannot reliably
 *     produce either; they need the parameter names spelled out in the schema.
 *   - Each mega-tool's `execute` validates `action` and maps the flat params
 *     onto the original domain tool's `execute`, so all legacy behavior and
 *     error handling is preserved unchanged.
 */

type DomainTool = { execute: (args: any) => Promise<Record<string, any>> };
type DomainMap = Record<string, DomainTool>;

/** Dispatch helper: run a domain tool by name with the given args. */
async function call(map: DomainMap, name: string, args: Record<string, any>): Promise<Record<string, any>> {
    const tool = map[name];
    if (!tool) return { status: 'error', error: `Internal routing error: ${name} not found` };
    return tool.execute(args);
}

/** Standard "unknown action" error with the list of valid actions. */
function badAction(action: string, valid: string[]): Record<string, any> {
    return { status: 'error', error: `Unknown action "${action}". Valid actions: ${valid.join(', ')}.` };
}

/**
 * Capability catalog for the `/tools` help reply. Category + blurb + example are
 * curated, but the tool LIST and action counts are read live from `megaTools`
 * below — so any tool we add later appears automatically (under "Other" until it
 * gets an entry here). Keeps `/tools` self-maintaining.
 */
interface HelpEntry { category: string; blurb: string; example: string; }
const HELP_META: Record<string, HelpEntry> = {
    manage_tasks: { category: '📋 Productivity', blurb: 'to-dos & recurring reminders', example: '"Add a task to call the bank" · "Remind me every Monday to do laundry"' },
    manage_calendar: { category: '📋 Productivity', blurb: 'Google Calendar', example: '"What\'s on today?" · "Add dentist tomorrow 3–4pm"' },
    manage_habits: { category: '📋 Productivity', blurb: 'habit tracking', example: '"Track a habit: drink water daily" · "I worked out today"' },
    manage_finances: { category: '💰 Money', blurb: 'expenses, income & budgets (NIS)', example: '"Spent 45 on coffee" · "Am I over budget?"' },
    manage_memory: { category: '📥 Info & memory', blurb: 'remember facts (with your approval)', example: '"Remember my anniversary is May 3"' },
    assistant_utils: { category: '📥 Info & memory', blurb: 'time, daily status, text-to-speech', example: '"What time is it?" · "What\'s my day look like?"' },
    manage_notes: { category: '📥 Info & memory', blurb: 'second-brain notes vault (auto-linked)', example: '"Save a note: …" · "What notes do I have about X?"' },
    manage_music: { category: '🎵 Media', blurb: 'Spotify playback & music alarms', example: '"Play Pink Floyd" · "Wake me with jazz at 7am"' },
    // DISABLED 2026-07-06 (re-enable with the matching tool blocks below):
    // manage_email: { category: '📥 Info & memory', blurb: 'read your inbox (can\'t send)', example: '"Any new emails?" · "Read email 12"' },
    // manage_photos: { category: '📥 Info & memory', blurb: 'Immich photo search & albums', example: '"Find beach photos" · "Make an album called Trip 2026"' },
};
const HELP_CATEGORY_ORDER = ['📋 Productivity', '💰 Money', '📥 Info & memory', '🎵 Media', '🧩 Other'];

/** Build the grouped capabilities list straight from the live registry. */
function buildHelp(): string {
    const groups: Record<string, string[]> = {};
    let totalActions = 0;
    for (const [name, tool] of Object.entries(megaTools as Record<string, any>)) {
        const actions: string[] = tool?.parameters?.properties?.action?.enum || [];
        totalActions += actions.length || 1;
        const meta = HELP_META[name];
        const cat = meta?.category || '🧩 Other';
        const blurb = meta?.blurb || String(tool.description || '').split('.')[0];
        let line = `• ${name} — ${blurb}` + (actions.length ? ` (${actions.length} actions)` : '');
        if (meta) line += `\n   e.g. ${meta.example}`;
        (groups[cat] = groups[cat] || []).push(line);
    }
    const cats = [...HELP_CATEGORY_ORDER, ...Object.keys(groups).filter(c => !HELP_CATEGORY_ORDER.includes(c))];
    const out: string[] = ['🧰 Astra — here\'s what I can do', ''];
    for (const c of cats) {
        if (!groups[c] || groups[c].length === 0) continue;
        out.push(c, ...groups[c], '');
    }
    out.push(`Tip: say /tools or "what can you do?" anytime. (${Object.keys(megaTools).length} tools, ${totalActions} actions)`);
    return out.join('\n');
}

export const megaTools = {
    // ─── 1. Tasks (one-off + recurring) ──────────────────────────────
    manage_tasks: {
        name: 'manage_tasks',
        description:
            "Manage the user's to-do list and recurring task templates. " +
            "Choose action: 'add' (needs title, optional priority), 'list', " +
            "'complete' (needs task_id), 'delete' (needs task_id), " +
            "'add_recurring' (needs title + frequency; weekly needs day_of_week 0-6, monthly needs day_of_month 1-31), " +
            "'list_recurring', 'remove_recurring' (needs recurring_id).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add', 'list', 'complete', 'delete', 'add_recurring', 'list_recurring', 'remove_recurring'], description: 'Which task operation to perform' },
                title: { type: 'string', description: 'Task description (for add / add_recurring)' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Task priority (default medium)' },
                task_id: { type: 'string', description: 'Task ID like T1, or part of the title (for complete / delete)' },
                frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Recurrence (for add_recurring)' },
                day_of_week: { type: 'number', description: 'Weekly recurrence day: 0=Sunday .. 6=Saturday' },
                day_of_month: { type: 'number', description: 'Monthly recurrence day: 1-31' },
                recurring_id: { type: 'number', description: 'Recurring template ID (for remove_recurring)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'add': return call(taskTools as DomainMap, 'add_task', { title: a.title, priority: a.priority });
                case 'list': return call(taskTools as DomainMap, 'list_tasks', {});
                case 'complete': return call(taskTools as DomainMap, 'complete_task', { taskId: a.task_id });
                case 'delete': return call(taskTools as DomainMap, 'delete_task', { taskId: a.task_id });
                case 'add_recurring': return call(recurringTaskTools as DomainMap, 'add_recurring_task', { title: a.title, priority: a.priority, frequency: a.frequency, day_of_week: a.day_of_week, day_of_month: a.day_of_month });
                case 'list_recurring': return call(recurringTaskTools as DomainMap, 'list_recurring_tasks', {});
                case 'remove_recurring': return call(recurringTaskTools as DomainMap, 'remove_recurring_task', { id: a.recurring_id });
                default: return badAction(a.action, ['add', 'list', 'complete', 'delete', 'add_recurring', 'list_recurring', 'remove_recurring']);
            }
        },
    },

    // ─── 2. Finances (expenses + income + budgets) ───────────────────
    manage_finances: {
        name: 'manage_finances',
        description:
            "Track money: expenses, income, and monthly budgets (all in NIS). " +
            "Choose action: 'add_expense' (amount, category, description), " +
            "'expense_summary' (optional period week|month), 'add_income' (amount, source, description), " +
            "'financial_overview' (optional period week|month|year), 'set_budget' (category, monthly_limit), " +
            "'list_budgets', 'budget_alerts'.",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add_expense', 'expense_summary', 'add_income', 'financial_overview', 'set_budget', 'list_budgets', 'budget_alerts'], description: 'Which finance operation to perform' },
                amount: { type: 'number', description: 'Amount in NIS (for add_expense / add_income)' },
                category: { type: 'string', description: 'Expense category (for add_expense / set_budget)' },
                description: { type: 'string', description: 'Short note (for add_expense / add_income)' },
                source: { type: 'string', description: 'Income source e.g. salary, freelance (for add_income)' },
                period: { type: 'string', enum: ['week', 'month', 'year'], description: 'Time window for summaries' },
                monthly_limit: { type: 'number', description: 'Monthly budget limit in NIS (for set_budget)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'add_expense': return call(expenseTools as DomainMap, 'add_expense', { amount: a.amount, category: a.category, description: a.description });
                case 'expense_summary': return call(expenseTools as DomainMap, 'get_expense_summary', { period: a.period });
                case 'add_income': return call(expenseTools as DomainMap, 'add_income', { amount: a.amount, source: a.source, description: a.description });
                case 'financial_overview': return call(expenseTools as DomainMap, 'get_financial_overview', { period: a.period });
                case 'set_budget': return call(budgetTools as DomainMap, 'set_budget', { category: a.category, monthly_limit: a.monthly_limit });
                case 'list_budgets': return call(budgetTools as DomainMap, 'list_budgets', {});
                case 'budget_alerts': return call(budgetTools as DomainMap, 'check_budget_alerts', {});
                default: return badAction(a.action, ['add_expense', 'expense_summary', 'add_income', 'financial_overview', 'set_budget', 'list_budgets', 'budget_alerts']);
            }
        },
    },

    // ─── 3. Calendar ─────────────────────────────────────────────────
    manage_calendar: {
        name: 'manage_calendar',
        description:
            "Read or add Google Calendar events. Choose action: 'list' (optional max_results) " +
            "or 'add' (needs summary, start, end in ISO format e.g. 2026-06-23T14:00:00; optional location, description).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'add'], description: 'List upcoming events or add a new one' },
                max_results: { type: 'number', description: 'How many events to list (default 10)' },
                summary: { type: 'string', description: 'Event title (for add)' },
                location: { type: 'string', description: 'Location or meeting link (for add)' },
                description: { type: 'string', description: 'Event notes (for add)' },
                start: { type: 'string', description: 'ISO start datetime e.g. 2026-06-23T14:00:00 (for add)' },
                end: { type: 'string', description: 'ISO end datetime e.g. 2026-06-23T15:00:00 (for add)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'list': return call(calendarTools as DomainMap, 'list_calendar_events', { maxResults: a.max_results });
                case 'add': return call(calendarTools as DomainMap, 'add_calendar_event', { summary: a.summary, location: a.location, description: a.description, startDateTime: a.start, endDateTime: a.end });
                default: return badAction(a.action, ['list', 'add']);
            }
        },
    },

    // ─── 4. Habits ───────────────────────────────────────────────────
    manage_habits: {
        name: 'manage_habits',
        description:
            "Track personal habits. Choose action: 'track' (start tracking; needs name + frequency), " +
            "'log' (mark a habit done today; needs name), or 'list' (show all habits).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['track', 'log', 'list'], description: 'Habit operation to perform' },
                name: { type: 'string', description: 'Habit name (for track / log)' },
                frequency: { type: 'string', description: "How often e.g. 'daily', 'weekly' (for track)" },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'track': return call(habitTools as DomainMap, 'track_habit', { name: a.name, frequency: a.frequency });
                case 'log': return call(habitTools as DomainMap, 'log_habit', { name: a.name });
                case 'list': return call(habitTools as DomainMap, 'list_habits', {});
                default: return badAction(a.action, ['track', 'log', 'list']);
            }
        },
    },

    /* ─── DISABLED 2026-07-06 (speed trim) — manage_email & manage_photos ───
       Removed from the chat surface to shrink the system prompt. The domain
       logic is untouched in ../email, ../email-digest and ../immich. To
       RE-ENABLE: uncomment the imports + HELP_META entries above and this
       block, then `npm run build` and restore the photo_management skill.

    // ─── 5. Email (read-only IMAP) ───────────────────────────────────
    manage_email: {
        name: 'manage_email',
        description:
            "Read-only email access (cannot send). Choose action: 'list' (recent emails; optional count, account, folder), " +
            "'read' (full email by uid; optional account), or 'digest' (unread counts + latest subjects across accounts). " +
            "Account is 'personal' (default) or 'university'.",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'read', 'digest'], description: 'Email operation to perform' },
                count: { type: 'number', description: 'How many recent emails to list (default 10, max 30)' },
                account: { type: 'string', enum: ['personal', 'university'], description: "Which inbox (default 'personal')" },
                folder: { type: 'string', description: "Mailbox folder (default 'INBOX')" },
                uid: { type: 'number', description: 'Email UID to read (from a prior list)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'list': return call(emailTools as DomainMap, 'list_recent_emails', { count: a.count, account: a.account, folder: a.folder });
                case 'read': return call(emailTools as DomainMap, 'read_email', { uid: a.uid, account: a.account });
                case 'digest': return call(emailDigestTools as DomainMap, 'get_email_digest', {});
                default: return badAction(a.action, ['list', 'read', 'digest']);
            }
        },
    },

    // ─── 6. Photos (Immich) ──────────────────────────────────────────
    manage_photos: {
        name: 'manage_photos',
        description:
            "Query and organize the Immich photo library (never deletes). Choose action: 'stats', " +
            "'search' (semantic search; needs query in English, optional limit), 'list_albums', " +
            "'create_album' (needs album_name, optional album_description), " +
            "'add_to_album' (needs album_id and asset_ids).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['stats', 'search', 'list_albums', 'create_album', 'add_to_album'], description: 'Photo operation to perform' },
                query: { type: 'string', description: 'Semantic search query in English (for search)' },
                limit: { type: 'number', description: 'Max search results (default 10, max 50)' },
                album_name: { type: 'string', description: 'New album name (for create_album)' },
                album_description: { type: 'string', description: 'New album description (for create_album)' },
                album_id: { type: 'string', description: 'Target album ID (for add_to_album)' },
                asset_ids: { type: 'array', items: { type: 'string' }, description: 'Photo asset IDs to add (for add_to_album)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'stats': return call(immichTools as DomainMap, 'immich_stats', {});
                case 'search': return call(immichTools as DomainMap, 'immich_search_photos', { query: a.query, limit: a.limit });
                case 'list_albums': return call(immichTools as DomainMap, 'immich_list_albums', {});
                case 'create_album': return call(immichTools as DomainMap, 'immich_create_album', { name: a.album_name, description: a.album_description });
                case 'add_to_album': return call(immichTools as DomainMap, 'immich_add_to_album', { albumId: a.album_id, assetIds: a.asset_ids });
                default: return badAction(a.action, ['stats', 'search', 'list_albums', 'create_album', 'add_to_album']);
            }
        },
    },
    ─── end disabled block ─── */

    // ─── Memory (approval-based facts) ───────────────────────────────
    manage_memory: {
        name: 'manage_memory',
        description:
            "Remember personal facts with user approval. Choose action: 'propose' (suggest a new fact to remember; " +
            "needs fact — this asks the user to confirm, it does NOT save yet), 'approve' (save the pending fact after the user says yes), " +
            "or 'decline' (discard the pending fact after the user says no).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['propose', 'approve', 'decline'], description: 'Memory operation to perform' },
                fact: { type: 'string', description: 'The fact/preference to remember (for propose)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'propose': return call(memoryTools as DomainMap, 'propose_new_fact', { proposed_fact: a.fact });
                case 'approve': return call(memoryTools as DomainMap, 'approve_fact', { approved: true });
                case 'decline': return call(memoryTools as DomainMap, 'approve_fact', { approved: false });
                default: return badAction(a.action, ['propose', 'approve', 'decline']);
            }
        },
    },

    // ─── 8. Assistant utilities (time, web, status, voice, media) ────
    assistant_utils: {
        name: 'assistant_utils',
        description:
            "Misc assistant helpers. Choose action: 'help' (list everything Astra can do — use for /tools, /help, or 'what can you do?'), " +
            "'current_time' (date/time in Israel), " +
            "'daily_status' (pending tasks + habits summary), " +
            "'speak' (say a reply aloud — speakers or WhatsApp voice per the current mode; needs text), " +
            "'set_voice_mode' (needs mode: speakers/whatsapp/off), 'get_voice_mode', " +
            "'text_to_speech' (needs text, max 500 chars), 'list_whatsapp_media' (recent received media; optional count, media_type). " +
            "For real-time info (news, weather, current events) use the native web_search tool directly, not this one.",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['help', 'current_time', 'daily_status', 'speak', 'set_voice_mode', 'get_voice_mode', 'text_to_speech', 'list_whatsapp_media'], description: 'Helper to run' },
                text: { type: 'string', description: 'Text to speak (for speak / text_to_speech)' },
                mode: { type: 'string', enum: ['speakers', 'whatsapp', 'off'], description: 'Voice output mode (for set_voice_mode)' },
                count: { type: 'number', description: 'How many media items (for list_whatsapp_media)' },
                media_type: { type: 'string', enum: ['image', 'video', 'document'], description: 'Filter media (for list_whatsapp_media)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'help':
                    return { status: 'success', message: buildHelp() };
                case 'current_time': {
                    const t = new Date().toLocaleString('en-IL', { timeZone: config.timezone });
                    return { current_time: t };
                }
                case 'daily_status': return call(dailyStatusTools as DomainMap, 'get_daily_status', {});
                case 'speak': return call(voiceTools as DomainMap, 'speak', { text: a.text });
                case 'set_voice_mode': return call(voiceTools as DomainMap, 'set_voice_mode', { mode: a.mode });
                case 'get_voice_mode': return call(voiceTools as DomainMap, 'get_voice_mode', {});
                case 'text_to_speech': return call(voiceTools as DomainMap, 'text_to_speech', { text: a.text });
                case 'list_whatsapp_media': return call(whatsappMediaTools as DomainMap, 'list_whatsapp_media', { count: a.count, media_type: a.media_type });
                default: return badAction(a.action, ['help', 'current_time', 'daily_status', 'speak', 'set_voice_mode', 'get_voice_mode', 'text_to_speech', 'list_whatsapp_media']);
            }
        },
    },

    // ─── 9. Music (Spotify → spotifyd on the Mac) ────────────────────
    // RE-ENABLED 2026-08-06: spotifyd was never uninstalled (brew 0.4.2, config
    // + cached OAuth intact) — it had only been stopped. The 2026-07-06 "speed
    // trim" reason is also gone: that was to shrink the system prompt for the
    // local 8B model, and the engine is Gemini now.
    manage_music: {
        name: 'manage_music',
        description:
            "Control Spotify playback on the Mac. Choose action: 'play' (resume, or play something specific via optional query + type), " +
            "'pause', 'next', 'previous', 'volume' (needs volume_percent 0-100), 'now_playing' (what's playing), " +
            "'set_alarm' (auto-play music at a time: needs query + hour, optional type/minute/days), 'list_alarms', or 'cancel_alarm' (needs alarm_id).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume', 'now_playing', 'set_alarm', 'list_alarms', 'cancel_alarm'], description: 'Operation to perform' },
                query: { type: 'string', description: "What to play, e.g. 'lofi beats' (for play/set_alarm; omit to resume)" },
                type: { type: 'string', enum: ['track', 'album', 'playlist', 'artist', 'podcast'], description: "For play/set_alarm: what kind of thing 'query' is. Default 'track'." },
                volume_percent: { type: 'number', description: 'Volume 0-100 (for volume)' },
                hour: { type: 'number', description: 'For set_alarm: hour 0-23 (local time).' },
                minute: { type: 'number', description: 'For set_alarm: minute 0-59 (default 0).' },
                days: { type: 'string', description: "For set_alarm: 'daily' or CSV weekday numbers 0=Sun..6=Sat (e.g. '1,2,3,4,5' weekdays). Default 'daily'." },
                alarm_id: { type: 'number', description: 'For cancel_alarm: the alarm id from list_alarms.' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'play': return call(spotifyTools as DomainMap, 'spotify_play', { query: a.query, type: a.type });
                case 'pause': return call(spotifyTools as DomainMap, 'spotify_pause', {});
                case 'next': return call(spotifyTools as DomainMap, 'spotify_next', {});
                case 'previous': return call(spotifyTools as DomainMap, 'spotify_previous', {});
                case 'volume': return call(spotifyTools as DomainMap, 'spotify_volume', { volume_percent: a.volume_percent });
                case 'now_playing': return call(spotifyTools as DomainMap, 'spotify_now_playing', {});
                case 'set_alarm': return call(spotifyTools as DomainMap, 'spotify_set_alarm', { query: a.query, type: a.type, hour: a.hour, minute: a.minute, days: a.days });
                case 'list_alarms': return call(spotifyTools as DomainMap, 'spotify_list_alarms', {});
                case 'cancel_alarm': return call(spotifyTools as DomainMap, 'spotify_cancel_alarm', { alarm_id: a.alarm_id });
                default: return badAction(a.action, ['play', 'pause', 'next', 'previous', 'volume', 'now_playing', 'set_alarm', 'list_alarms', 'cancel_alarm']);
            }
        },
    },

    // ─── Notes (second-brain Obsidian vault) ─────────────────────────
    manage_notes: {
        name: 'manage_notes',
        description:
            "The user's second-brain notes (an Obsidian markdown vault). Choose action: " +
            "'add' (save a note; needs title + content, optional tags — auto-links to related notes), " +
            "'find' (search notes; needs query), 'list' (all note titles), " +
            "'link' (connect two notes; needs from_title + to_title), " +
            "'delete' (permanently remove a note; needs title — confirm with the user first).",
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add', 'find', 'list', 'link', 'delete'], description: 'Notes operation to perform' },
                title: { type: 'string', description: 'Note title (for add / delete)' },
                content: { type: 'string', description: 'Note body (for add)' },
                tags: { type: 'string', description: "Optional comma-separated tags (for add)" },
                query: { type: 'string', description: 'Search text (for find)' },
                from_title: { type: 'string', description: 'Note to add a link into (for link)' },
                to_title: { type: 'string', description: 'Note to link to (for link)' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            switch (a.action) {
                case 'add': return call(notesTools as DomainMap, 'add_note', { title: a.title, content: a.content, tags: a.tags });
                case 'find': return call(notesTools as DomainMap, 'find_notes', { query: a.query });
                case 'list': return call(notesTools as DomainMap, 'list_notes', {});
                case 'link': return call(notesTools as DomainMap, 'link_note', { from_title: a.from_title, to_title: a.to_title });
                case 'delete': return call(notesTools as DomainMap, 'delete_note', { title: a.title });
                default: return badAction(a.action, ['add', 'find', 'list', 'link', 'delete']);
            }
        },
    },
};
