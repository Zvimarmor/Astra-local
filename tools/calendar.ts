import { getCalendarClient } from './google-auth';
import { config } from './config';

/**
 * Google Calendar Tools
 *
 * Ported from the AWS WhatsApp Bot — identical functionality.
 * Uses the same service account and calendar ID.
 */

const TIMEZONE = config.timezone;

/** Compact a raw Google event into the few fields the model actually needs. */
function compactEvent(e: any) {
    return {
        id: e.id,
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        all_day: Boolean(e.start?.date && !e.start?.dateTime),
        location: e.location || undefined,
    };
}

export const calendarTools = {
    list_calendar_events: {
        name: "list_calendar_events",
        description: "List upcoming events from the user's Google Calendar.",
        parameters: {
            type: "object",
            properties: {
                maxResults: { type: "number", description: "Number of events to return (default: 10)" }
            }
        },
        execute: async (args: any) => {
            try {
                const calendar = getCalendarClient();
                const res = await calendar.events.list({
                    calendarId: config.calendarId,
                    timeMin: new Date().toISOString(),
                    timeZone: TIMEZONE,
                    maxResults: args.maxResults || 10,
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                const events = (res.data.items || []).map(compactEvent);
                return { status: "success", count: events.length, events };
            } catch (err: any) {
                console.error("[Calendar] Error listing events:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    add_calendar_event: {
        name: "add_calendar_event",
        description: "Add a new event to the user's Google Calendar. Times should be in ISO format.",
        parameters: {
            type: "object",
            properties: {
                summary: { type: "string", description: "Title of the event" },
                location: { type: "string", description: "Location or meeting link" },
                description: { type: "string", description: "Notes for the event" },
                startDateTime: { type: "string", description: "ISO start time, e.g. 2026-04-21T14:00:00" },
                endDateTime: { type: "string", description: "ISO end time, e.g. 2026-04-21T15:00:00" }
            },
            required: ["summary", "startDateTime", "endDateTime"]
        },
        execute: async (args: any) => {
            if (typeof args.summary !== 'string' || typeof args.startDateTime !== 'string' || typeof args.endDateTime !== 'string') {
                return { status: "error", error: "Invalid argument format. summary, startDateTime, and endDateTime must be strings." };
            }

            try {
                const calendar = getCalendarClient();
                const res = await calendar.events.insert({
                    calendarId: config.calendarId,
                    requestBody: {
                        summary: args.summary,
                        location: args.location,
                        description: args.description,
                        start: { dateTime: args.startDateTime, timeZone: TIMEZONE },
                        end: { dateTime: args.endDateTime, timeZone: TIMEZONE },
                    },
                });
                console.log(`[Calendar] Added event: "${args.summary}" at ${args.startDateTime}`);
                return { status: "success", message: `Added "${args.summary}"`, event: compactEvent(res.data) };
            } catch (err: any) {
                console.error(`[Calendar] Failed to add event "${args.summary}":`, err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    delete_calendar_event: {
        name: "delete_calendar_event",
        description:
            "Delete an event from the user's Google Calendar. Accepts either a Google event id " +
            "(as returned by list_calendar_events) or part of the event title. A title that matches " +
            "more than one upcoming event deletes nothing and returns the candidates to choose from.",
        parameters: {
            type: "object",
            properties: {
                eventId: { type: "string", description: "Google event id, or part of the event title" }
            },
            required: ["eventId"]
        },
        execute: async (args: any) => {
            if (typeof args.eventId !== 'string' || args.eventId.trim() === '') {
                return { status: "error", error: "eventId must be a non-empty string (event id or part of the title)." };
            }
            const needle = args.eventId.trim();

            try {
                const calendar = getCalendarClient();

                // Resolve the reference to exactly one upcoming event before deleting.
                // Deleting is irreversible, so an ambiguous title must never guess.
                const res = await calendar.events.list({
                    calendarId: config.calendarId,
                    timeMin: new Date().toISOString(),
                    timeZone: TIMEZONE,
                    maxResults: 100,
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                const upcoming = (res.data.items || []).map(compactEvent);

                let target = upcoming.find(e => e.id === needle);
                if (!target) {
                    const lower = needle.toLowerCase();
                    const matches = upcoming.filter(e => e.title.toLowerCase().includes(lower));
                    if (matches.length === 0) {
                        return { status: "error", error: `No upcoming event matching "${needle}".` };
                    }
                    if (matches.length > 1) {
                        return {
                            status: "ambiguous",
                            message: `${matches.length} upcoming events match "${needle}" — ask which one, then pass its id.`,
                            events: matches,
                        };
                    }
                    target = matches[0];
                }

                await calendar.events.delete({ calendarId: config.calendarId, eventId: target.id! });
                console.log(`[Calendar] Deleted event: "${target.title}" at ${target.start}`);
                return { status: "success", message: `Deleted "${target.title}"`, event: target };
            } catch (err: any) {
                console.error(`[Calendar] Failed to delete event "${needle}":`, err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
