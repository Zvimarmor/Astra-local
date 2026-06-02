import { google } from 'googleapis';
import fs from 'fs';
import { config } from './config';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * Shared Google Auth client using service account.
 * Reuses the same service_account.json from the AWS WhatsApp Bot.
 */
export function getGoogleAuth(scopes: string[] = SCOPES) {
    if (!fs.existsSync(config.serviceAccountPath)) {
        throw new Error(`Missing service account file at: ${config.serviceAccountPath}. Copy it from the WhatsApp Bot project.`);
    }
    return new google.auth.GoogleAuth({
        keyFile: config.serviceAccountPath,
        scopes,
    });
}

/**
 * Get a Google Calendar client.
 */
export function getCalendarClient() {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/calendar']);
    return google.calendar({ version: 'v3', auth });
}
