import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * Notes Tools — "Second Brain" Obsidian-compatible vault.
 *
 * Writes plain Markdown files (one note per file) into config.vaultDir. The
 * folder IS an Obsidian vault: notes link to each other with [[wikilinks]],
 * so Obsidian's graph/backlinks work with zero extra wiring. No Obsidian app
 * is required to write — it's only a viewer over these files.
 *
 * Linking (MVP): deterministic keyword/tag overlap against existing note
 * titles + tags. Cheap, reliable, and crucially it never feeds whole notes to
 * the 8B model (which would overflow context). Semantic embedding-based links
 * are a planned upgrade — see skills/notes/SKILL.md.
 *
 * Safety:
 *   - Filenames are sanitized; every write/read path is verified to resolve
 *     INSIDE the vault (no path traversal).
 *   - Content is length-capped; tool output is compact (snippets, not bodies).
 */

const MAX_CONTENT = 20000;     // hard cap on a single note body
const MAX_TITLE = 80;          // filename length cap
const MAX_LINKS = 3;           // auto-suggested links per new note
const MAX_FIND = 5;            // results returned by find
const SNIPPET = 160;           // chars of body shown in find results

const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this',
    'that', 'from', 'have', 'has', 'was', 'were', 'will', 'what', 'when', 'how',
    'about', 'into', 'than', 'then', 'them', 'they', 'some', 'just', 'like',
]);

/** Strip characters Obsidian/macOS forbid in filenames; keep spaces + Hebrew. */
function sanitizeTitle(raw: string): string {
    return String(raw || '')
        .replace(/[*"\\/<>:|?]/g, ' ')   // illegal filename chars
        .replace(/[\x00-\x1f]/g, ' ')    // control chars
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE)
        .trim();
}

/** Absolute path for a note title, guaranteed to live directly in the vault. */
function notePath(title: string): string {
    const vault = path.resolve(config.vaultDir);
    const p = path.resolve(vault, `${title}.md`);
    if (path.dirname(p) !== vault) {
        throw new Error('Invalid note path (must be a single file inside the vault).');
    }
    return p;
}

function ensureVault(): string {
    const vault = path.resolve(config.vaultDir);
    fs.mkdirSync(vault, { recursive: true });
    return vault;
}

/** Lower-cased word tokens, English + Hebrew, length>=2, minus stopwords. */
function tokenize(text: string): Set<string> {
    const toks = String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9֐-׿]+/i)
        .filter(t => t.length >= 2 && !STOPWORDS.has(t));
    return new Set(toks);
}

interface NoteMeta { title: string; tags: string[]; file: string; body: string; }

/** Read a note file, pulling title/tags from YAML frontmatter if present. */
function readNote(file: string): NoteMeta {
    const base = path.basename(file, '.md');
    let title = base;
    let tags: string[] = [];
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }

    let body = raw;
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
        body = raw.slice(fm[0].length);
        const tMatch = fm[1].match(/^title:\s*(.+)$/m);
        if (tMatch) title = tMatch[1].trim().replace(/^["']|["']$/g, '');
        const gMatch = fm[1].match(/^tags:\s*\[(.*)\]\s*$/m);
        if (gMatch) tags = gMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return { title, tags, file, body };
}

function loadVault(): NoteMeta[] {
    const vault = ensureVault();
    return fs.readdirSync(vault)
        .filter(f => f.toLowerCase().endsWith('.md'))
        .map(f => readNote(path.join(vault, f)));
}

/** Score = weighted token overlap. Title/tag tokens count more than body. */
function relatedScore(queryToks: Set<string>, note: NoteMeta): number {
    const titleToks = tokenize(note.title + ' ' + note.tags.join(' '));
    const bodyToks = tokenize(note.body);
    let score = 0;
    for (const t of queryToks) {
        if (titleToks.has(t)) score += 3;
        else if (bodyToks.has(t)) score += 1;
    }
    return score;
}

export const notesTools = {
    add_note: {
        name: 'add_note',
        description: "Save a note to the second-brain vault and auto-link it to related existing notes.",
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short note title' },
                content: { type: 'string', description: 'The note body (Markdown allowed)' },
                tags: { type: 'string', description: "Optional comma-separated tags, e.g. 'work,idea'" },
            },
            required: ['title', 'content'],
        },
        execute: async (args: any = {}) => {
            try {
                const title = sanitizeTitle(args.title);
                if (!title) return { status: 'error', error: 'A note title is required.' };
                const content = String(args.content || '').trim().slice(0, MAX_CONTENT);
                if (!content) return { status: 'error', error: 'Note content is empty.' };
                const tags = String(args.tags || '')
                    .split(',').map((t: string) => t.trim()).filter(Boolean).slice(0, 12);

                ensureVault();

                // Find related notes (keyword/tag overlap) to link.
                const existing = loadVault();
                const qToks = tokenize(`${title} ${tags.join(' ')} ${content}`);
                const related = existing
                    .map(n => ({ n, score: relatedScore(qToks, n) }))
                    .filter(x => x.score > 0 && x.n.title.toLowerCase() !== title.toLowerCase())
                    .sort((a, b) => b.score - a.score)
                    .slice(0, MAX_LINKS)
                    .map(x => x.n.title);

                // Resolve a non-clobbering filename.
                let finalTitle = title;
                for (let i = 2; fs.existsSync(notePath(finalTitle)); i++) {
                    finalTitle = `${title} ${i}`;
                }

                const created = new Date().toISOString();
                const frontmatter = [
                    '---',
                    `title: ${finalTitle}`,
                    `created: ${created}`,
                    `tags: [${tags.join(', ')}]`,
                    '---',
                    '',
                ].join('\n');
                const linksBlock = related.length
                    ? '\n\n## Related\n' + related.map(t => `- [[${t}]]`).join('\n') + '\n'
                    : '\n';

                const file = notePath(finalTitle);
                fs.writeFileSync(file, frontmatter + content + linksBlock, 'utf8');

                return {
                    status: 'success',
                    title: finalTitle,
                    file: path.basename(file),
                    linked_to: related,
                    message: related.length
                        ? `Saved "${finalTitle}" and linked it to: ${related.map(t => `[[${t}]]`).join(', ')}.`
                        : `Saved "${finalTitle}". No related notes found yet to link.`,
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    find_notes: {
        name: 'find_notes',
        description: 'Search the second-brain vault for notes matching a query (title, tags, and body).',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look for' },
            },
            required: ['query'],
        },
        execute: async (args: any = {}) => {
            try {
                const query = String(args.query || '').trim();
                if (!query) return { status: 'error', error: 'A search query is required.' };
                const qToks = tokenize(query);
                if (qToks.size === 0) return { status: 'success', count: 0, notes: [], message: 'Query too short to search.' };

                const results = loadVault()
                    .map(n => ({ n, score: relatedScore(qToks, n) }))
                    .filter(x => x.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, MAX_FIND)
                    .map(x => ({
                        title: x.n.title,
                        tags: x.n.tags,
                        snippet: x.n.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET),
                    }));

                return {
                    status: 'success',
                    count: results.length,
                    notes: results,
                    message: results.length ? `Found ${results.length} related note(s).` : 'No matching notes found.',
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    list_notes: {
        name: 'list_notes',
        description: 'List the titles of all notes in the second-brain vault.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const titles = loadVault().map(n => n.title).sort((a, b) => a.localeCompare(b));
                return { status: 'success', count: titles.length, titles };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    delete_note: {
        name: 'delete_note',
        description: 'Delete a note from the second-brain vault by its title. This is permanent — confirm with the user first.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The exact title of the note to delete' },
            },
            required: ['title'],
        },
        execute: async (args: any = {}) => {
            try {
                const title = sanitizeTitle(args.title);
                if (!title) return { status: 'error', error: 'A note title is required.' };
                const file = notePath(title);
                if (!fs.existsSync(file)) return { status: 'error', error: `Note "${title}" not found.` };
                fs.unlinkSync(file);
                return { status: 'success', title, message: `Deleted note "${title}". (Other notes may still show it as an unresolved [[link]].)` };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    link_note: {
        name: 'link_note',
        description: 'Manually add a [[wikilink]] from one existing note to another.',
        parameters: {
            type: 'object',
            properties: {
                from_title: { type: 'string', description: 'The note to add the link into' },
                to_title: { type: 'string', description: 'The note to link to' },
            },
            required: ['from_title', 'to_title'],
        },
        execute: async (args: any = {}) => {
            try {
                const fromTitle = sanitizeTitle(args.from_title);
                const toTitle = sanitizeTitle(args.to_title);
                if (!fromTitle || !toTitle) return { status: 'error', error: 'Both from_title and to_title are required.' };

                const fromFile = notePath(fromTitle);
                if (!fs.existsSync(fromFile)) return { status: 'error', error: `Note "${fromTitle}" not found.` };
                if (!fs.existsSync(notePath(toTitle))) return { status: 'error', error: `Target note "${toTitle}" not found.` };

                let raw = fs.readFileSync(fromFile, 'utf8');
                if (raw.includes(`[[${toTitle}]]`)) {
                    return { status: 'success', message: `"${fromTitle}" already links to [[${toTitle}]].` };
                }
                if (/\n## Related\n/.test(raw)) {
                    raw = raw.replace(/\n## Related\n/, `\n## Related\n- [[${toTitle}]]\n`);
                } else {
                    raw = raw.replace(/\s*$/, '') + `\n\n## Related\n- [[${toTitle}]]\n`;
                }
                fs.writeFileSync(fromFile, raw, 'utf8');
                return { status: 'success', message: `Linked "${fromTitle}" → [[${toTitle}]].` };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },
};
