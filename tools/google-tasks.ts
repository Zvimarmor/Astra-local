import fs from 'fs';
import { google, tasks_v1 } from 'googleapis';
import { config } from './config';
import {
    getTaskById, setGoogleTaskLink, getTasksNeedingGooglePush, getPendingTaskByGoogleId,
    completeTask, getSetting, setSetting, GOOGLE_TASK_UNLINKED, type TaskRow,
} from './storage';

/**
 * Google Tasks mirror — keeps a dedicated "Astra Tasks" list in step with the
 * SQLite rolling queue.
 *
 * SQLite stays the source of truth. The mirror is one-way for content and two-way
 * for exactly one thing:
 *   - Astra → Google: title, due date (COALESCE(deadline, planned_date)), notes
 *     ("[30 min] <title>"), completion and deletion. Pushed right after the
 *     manage_tasks action that changed them, and on reconcile for anything new
 *     (recurring_gen, tasks from before the mirror existed) or rolled over.
 *   - Google → Astra: COMPLETION only. Ticking a task off on the phone marks it
 *     done in SQLite on the next reconcile (list / suggest / plan_day / the
 *     morning briefing). Edits to title/date in Google are not read back, so the
 *     next reschedule in Astra overwrites them.
 * A task the user DELETES in Google is unlinked (GOOGLE_TASK_UNLINKED) instead of
 * re-created — deleting it there reads as "stop mirroring this", not "lost".
 *
 * Every entry point is best-effort and never throws: Google being down, the token
 * being revoked, or the mirror not being set up at all must never fail a task
 * action. Callers get a short status string to surface if they want.
 *
 * AUTH: user OAuth (refresh token in config.googleTasks.tokenPath, written once by
 * `npm run auth:google-tasks`), NOT the Calendar service account — see config.ts.
 */

export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const REQUEST_TIMEOUT_MS = 8_000;
/** Reconcile at most this often; list/suggest/plan_day can fire back-to-back. */
const RECONCILE_MIN_INTERVAL_MS = 2 * 60 * 1000;
/** Overlap on `updatedMin` so a completion landing mid-reconcile isn't skipped. */
const UPDATED_MIN_SLACK_MS = 10 * 60 * 1000;

export type SyncStatus = 'synced' | 'off' | 'error' | 'unlinked';

let client: tasks_v1.Tasks | null | undefined;
let lastReconcileAt = 0;
/** Outcome of the last real reconcile — what a throttled call reports, so it can't paper over a failure. */
let lastReconcileStatus: SyncStatus = 'synced';
let lastReconcileError: string | undefined;

/** Load the OAuth client + stored token. null = mirror not configured (not an error). */
function getClient(): tasks_v1.Tasks | null {
    if (client !== undefined) return client;
    const { oauthClientPath, tokenPath } = config.googleTasks;
    if (!fs.existsSync(oauthClientPath) || !fs.existsSync(tokenPath)) {
        client = null;
        return client;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
        const c = raw.installed || raw.web || raw;
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        const auth = new google.auth.OAuth2(c.client_id, c.client_secret);
        auth.setCredentials(token);
        client = google.tasks({ version: 'v1', auth, timeout: REQUEST_TIMEOUT_MS } as any);
    } catch (e: any) {
        console.error('[GoogleTasks] could not load OAuth credentials:', e?.message);
        client = null;
    }
    return client;
}

export function isGoogleTasksEnabled(): boolean {
    return getClient() !== null;
}

const status = (e: any): number | undefined => e?.code ?? e?.response?.status;

/** Id of the dedicated list, created on first use. Cached in `settings`. */
async function getListId(api: tasks_v1.Tasks): Promise<string> {
    const cached = getSetting('gtasks_list_id');
    if (cached) {
        try {
            await api.tasklists.get({ tasklist: cached });
            return cached;
        } catch (e: any) {
            if (status(e) !== 404) throw e;   // only a deleted list is a reason to re-resolve
        }
    }
    const name = config.googleTasks.listName;
    let pageToken: string | undefined;
    do {
        const res = await api.tasklists.list({ maxResults: 100, pageToken });
        const hit = (res.data.items || []).find(l => l.title === name);
        if (hit?.id) { setSetting('gtasks_list_id', hit.id); return hit.id; }
        pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    const created = await api.tasklists.insert({ requestBody: { title: name } });
    setSetting('gtasks_list_id', created.data.id!);
    return created.data.id!;
}

/** Notes line the user sees on the phone: "[30 min] <title>", then any notes, then the Astra id. */
function buildBody(t: TaskRow): tasks_v1.Schema$Task {
    const due = t.deadline || t.planned_date;
    const lines = [t.estimated_minutes ? `[${t.estimated_minutes} min] ${t.title}` : t.title];
    if (t.notes) lines.push(t.notes);
    if (t.deadline) lines.push(`⏰ deadline ${t.deadline}`);
    lines.push(`— Astra ${t.id}`);
    return {
        title: t.title,
        notes: lines.join('\n'),
        // Tasks stores only the date part; time-of-day is discarded by the API.
        due: due ? `${due}T00:00:00.000Z` : null,
        status: t.status === 'Completed' ? 'completed' : 'needsAction',
    };
}

async function pushOne(api: tasks_v1.Tasks, listId: string, t: TaskRow): Promise<SyncStatus> {
    if (t.google_task_id === GOOGLE_TASK_UNLINKED) return 'unlinked';
    const body = buildBody(t);
    if (t.google_task_id) {
        try {
            // Full update, so a cleared date really clears `due` (patch would ignore a null).
            await api.tasks.update({ tasklist: listId, task: t.google_task_id, requestBody: { ...body, id: t.google_task_id } });
            setGoogleTaskLink(t.id, t.google_task_id);
            return 'synced';
        } catch (e: any) {
            if (status(e) !== 404) throw e;
            setGoogleTaskLink(t.id, GOOGLE_TASK_UNLINKED);
            return 'unlinked';
        }
    }
    if (t.status === 'Completed') return 'synced';   // never mirrored, and nothing left to do
    const res = await api.tasks.insert({ tasklist: listId, requestBody: body });
    setGoogleTaskLink(t.id, res.data.id!);
    return 'synced';
}

/** Push one task's current state (create / update / complete). Call after any change. */
export async function syncTaskToGoogle(taskId: string): Promise<SyncStatus> {
    const api = getClient();
    if (!api) return 'off';
    try {
        const t = getTaskById(taskId);
        if (!t) return 'error';
        return await pushOne(api, await getListId(api), t);
    } catch (e: any) {
        console.error(`[GoogleTasks] push ${taskId} failed:`, e?.message);
        return 'error';
    }
}

/** Remove the Google copy. Takes the link captured BEFORE the SQLite row was deleted. */
export async function deleteGoogleTask(googleTaskId: string | null | undefined): Promise<SyncStatus> {
    const api = getClient();
    if (!api) return 'off';
    if (!googleTaskId || googleTaskId === GOOGLE_TASK_UNLINKED) return 'unlinked';
    try {
        await api.tasks.delete({ tasklist: await getListId(api), task: googleTaskId });
        return 'synced';
    } catch (e: any) {
        if (status(e) === 404) return 'synced';
        console.error('[GoogleTasks] delete failed:', e?.message);
        return 'error';
    }
}

export interface ReconcileResult {
    status: SyncStatus | 'throttled';
    completed: string[];
    pushed: number;
    /** On a throttled call: the status of the last reconcile that actually ran. */
    lastStatus?: SyncStatus;
    /** Short reason when status is 'error' (e.g. 'invalid_grant' = token expired/revoked). */
    error?: string;
}

/**
 * Pull completions from Google into SQLite, then push anything new or rescheduled.
 * Throttled (pass `force` from the once-a-day morning briefing). Never throws.
 */
export async function reconcileGoogleTasks(force = false): Promise<ReconcileResult> {
    const api = getClient();
    if (!api) return { status: 'off', completed: [], pushed: 0 };
    if (!force && Date.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
        return { status: 'throttled', completed: [], pushed: 0, lastStatus: lastReconcileStatus, error: lastReconcileError };
    }
    lastReconcileAt = Date.now();

    const completed: string[] = [];
    let pushed = 0;
    try {
        const listId = await getListId(api);

        // ── Google → Astra: completions ──
        const startedAt = new Date().toISOString();
        const since = getSetting('gtasks_last_pull');
        const updatedMin = since ? new Date(Date.parse(since) - UPDATED_MIN_SLACK_MS).toISOString() : undefined;
        let pageToken: string | undefined;
        do {
            const res = await api.tasks.list({
                tasklist: listId,
                showCompleted: true,
                showHidden: true,     // tasks ticked off in the mobile app are hidden, not just completed
                showDeleted: true,
                maxResults: 100,
                updatedMin,
                pageToken,
            });
            for (const g of res.data.items || []) {
                if (!g.id) continue;
                const local = getPendingTaskByGoogleId(g.id);
                if (!local) continue;
                if (g.deleted) {
                    setGoogleTaskLink(local.id, GOOGLE_TASK_UNLINKED);
                } else if (g.status === 'completed' && completeTask(local.id)) {
                    completed.push(local.id);
                }
            }
            pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);
        setSetting('gtasks_last_pull', startedAt);

        // ── Astra → Google: new rows and rollovers ──
        for (const t of getTasksNeedingGooglePush()) {
            if ((await pushOne(api, listId, t)) === 'synced') pushed++;
        }
        if (completed.length) console.log(`[GoogleTasks] completed from Google: ${completed.join(', ')}`);
        lastReconcileStatus = 'synced';
        lastReconcileError = undefined;
        return { status: 'synced', completed, pushed };
    } catch (e: any) {
        console.error('[GoogleTasks] reconcile failed:', e?.message);
        lastReconcileStatus = 'error';
        lastReconcileError = String(e?.message || e).slice(0, 120);
        return { status: 'error', completed, pushed, error: lastReconcileError };
    }
}
