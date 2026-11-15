import { getCalendarClient } from './google-auth';
import { config } from './config';
import * as storage from './storage';

/**
 * Chat side of email invitations (manage_email actions `invites`, `add_invite`,
 * `decline_invite`).
 *
 * The background email triage (services/email-triage.ts) finds invitations, stores them
 * in `email_invites` and asks the owner on WhatsApp whether to add them to the calendar.
 * When he says yes, the agent adds the STORED event by id, so the details come from the
 * stored row rather than being retyped by the model from untrusted email text. Nothing is
 * added without that answer.
 */

const TZ = config.timezone;

function today(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}

function addMinutes(hhmm: string, minutes: number): { time: string; nextDay: boolean } {
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + minutes;
    return { time: `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`, nextDay: total >= 24 * 60 };
}

function nextDate(date: string): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function view(r: storage.EmailInvite) {
    return {
        invite_id: r.id, title: r.title, date: r.event_date,
        start: r.start_time || 'all day', end: r.end_time || null, location: r.location,
        from: r.sender, subject: r.subject, status: r.status,
    };
}

export const emailInviteTools = {
    list_invites: {
        name: 'list_invites',
        execute: async () => {
            try {
                const open = storage.getOpenEmailInvites(today());
                return {
                    status: 'success',
                    count: open.length,
                    invites: open.map(view),
                    note: open.length
                        ? 'These are the invitations Astra asked about and the user has not answered. Add only the ones he said yes to.'
                        : 'No open invitations.',
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    add_invite: {
        name: 'add_invite',
        execute: async (a: any = {}) => {
            try {
                const id = parseInt(String(a.invite_id ?? '').replace(/^#/, ''), 10);
                const r = Number.isFinite(id) ? storage.getEmailInvite(id) : undefined;
                if (!r) return { status: 'error', error: 'No invitation with that invite_id. Call action="invites" to see the open ones.' };
                if (r.status === 'added') return { status: 'error', error: `"${r.title}" is already in the calendar.` };
                if (r.status === 'expired' || r.event_date < today()) return { status: 'error', error: `"${r.title}" has already passed.` };

                let start: any, end: any;
                if (r.start_time) {
                    const endTime = r.end_time || addMinutes(r.start_time, 60).time;
                    const endDate = !r.end_time && addMinutes(r.start_time, 60).nextDay ? nextDate(r.event_date) : r.event_date;
                    start = { dateTime: `${r.event_date}T${r.start_time}:00`, timeZone: TZ };
                    end = { dateTime: `${endDate}T${endTime}:00`, timeZone: TZ };
                } else {
                    start = { date: r.event_date };
                    end = { date: nextDate(r.event_date) };
                }
                const res = await getCalendarClient().events.insert({
                    calendarId: config.calendarId,
                    requestBody: {
                        summary: r.title,
                        location: r.location || undefined,
                        description: `נוסף מתוך מייל מ-${r.sender || '?'}: ${r.subject || ''}`.slice(0, 500),
                        start, end,
                    },
                });
                storage.setEmailInviteStatus(r.id, 'added', res.data.id || undefined);
                return {
                    status: 'success',
                    message: `Added "${r.title}" to the calendar.`,
                    event: { title: r.title, date: r.event_date, start: r.start_time || 'all day', end: r.end_time || (r.start_time ? '1 hour (end not in the email)' : null), location: r.location },
                };
            } catch (err: any) {
                return { status: 'error', error: String(err?.message || err).slice(0, 300) };
            }
        },
    },

    decline_invite: {
        name: 'decline_invite',
        execute: async (a: any = {}) => {
            try {
                const id = parseInt(String(a.invite_id ?? '').replace(/^#/, ''), 10);
                const r = Number.isFinite(id) ? storage.getEmailInvite(id) : undefined;
                if (!r) return { status: 'error', error: 'No invitation with that invite_id.' };
                storage.setEmailInviteStatus(r.id, 'declined');
                return { status: 'success', message: `Won't add "${r.title}".` };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },
};
