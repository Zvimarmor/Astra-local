/**
 * Duration & type heuristics — "how long will this actually take?"
 *
 * WHY THIS EXISTS
 *   Capacity-based planning is only as good as its durations. Before this, a task
 *   with no `estimated_minutes` was silently assumed to be 45 min, which made
 *   every plan for a day full of 10-minute phone calls wildly pessimistic (and a
 *   day of coding wildly optimistic). Rather than nag the user for an estimate on
 *   every single capture, we infer one.
 *
 * DELIBERATELY RULE-BASED, NOT LLM-BASED
 *   This runs inside `add_task`, inside the 07:00 scheduler tick, and inside
 *   `plan_day`. Two of those three paths must stay deterministic and offline —
 *   the scheduler's whole design property is "no model in the loop" (see
 *   CLAUDE.md), and a Gemini call there would both break that and burn the
 *   20-req/day free-tier quota. So: keyword tables, no network, no failure mode.
 *   The model can still override any inference by passing an explicit
 *   `estimated_minutes` — an explicit number always wins.
 *
 * BILINGUAL ON PURPOSE: the user captures tasks in Hebrew far more often than in
 * English, so a Hebrew-blind heuristic would fall back to the default almost
 * always and be worse than useless.
 */

/** The four buckets. Ordered from shortest to longest. */
export type TaskKind = 'quick' | 'chore' | 'focus' | 'deep';

/**
 * Minutes assigned per bucket. These are the midpoints of the ranges the buckets
 * describe, rounded to a quarter hour so calendar blocks land on clean times:
 *   quick 10–20 · chore 25–40 · focus 45–60 · deep 90–120
 */
export const KIND_MINUTES: Record<TaskKind, number> = {
    quick: 15,
    chore: 30,
    focus: 45,
    deep: 90,
};

/** Human labels, used in tool output so the user can see (and correct) the guess. */
export const KIND_LABEL: Record<TaskKind, string> = {
    quick: 'quick action',
    chore: 'chore/errand',
    focus: 'focused work',
    deep: 'deep work',
};

/** Used when nothing matches — a medium-focus block, the safest middle guess. */
export const DEFAULT_KIND: TaskKind = 'focus';
export const DEFAULT_MINUTES = KIND_MINUTES[DEFAULT_KIND];

/**
 * Keyword tables. Order within a list is irrelevant; when two buckets match, the
 * LONGER matched keyword wins (so "לכתוב פוסט" → focus beats "לכתוב" → deep).
 * Keep multi-word/more-specific phrases in the narrower bucket for that reason.
 */
const KEYWORDS: Record<TaskKind, string[]> = {
    quick: [
        // en
        'call', 'phone', 'text', 'message', 'whatsapp', 'reply', 'respond', 'email back',
        'answer', 'confirm', 'rsvp', 'book a', 'schedule a call', 'ping', 'remind',
        'sign up', 'renew', 'cancel', 'order online', 'check on', 'quick',
        // he
        'להתקשר', 'טלפון', 'שיחה', 'לשלוח הודעה', 'הודעה', 'וואטסאפ', 'לענות',
        'תשובה', 'לאשר', 'לקבוע תור', 'לקבוע', 'להזמין תור', 'תזכורת', 'לבטל',
        'להירשם', 'לחדש', 'מייל', 'אימייל', 'לשלוח מייל', 'מהיר',
    ],
    chore: [
        // en
        'groceries', 'shopping', 'supermarket', 'laundry', 'dishes', 'clean', 'cleaning',
        'tidy', 'organize', 'organise', 'water the plants', 'plants', 'trash', 'garbage',
        'errand', 'pharmacy', 'post office', 'bank', 'pick up', 'drop off', 'refuel',
        'gas station', 'wash', 'vacuum', 'cook', 'meal prep', 'pay bill', 'pay the',
        // he
        'קניות', 'סופר', 'מכולת', 'כביסה', 'כלים', 'לנקות', 'ניקיון', 'לסדר', 'סידור',
        'להשקות', 'צמחים', 'זבל', 'לזרוק', 'סידורים', 'בית מרקחת', 'דואר', 'בנק',
        'לאסוף', 'להוריד', 'לתדלק', 'לשטוף', 'לשאוב', 'לבשל', 'לשלם', 'תשלום', 'חשבון',
    ],
    focus: [
        // en
        'study', 'studying', 'revise', 'review', 'read', 'reading', 'docs', 'documentation',
        'draft', 'draft a post', 'write a post', 'post', 'summarize', 'summarise', 'summary',
        'notes', 'plan', 'planning', 'research', 'compare', 'form', 'paperwork', 'slides',
        'presentation', 'outline', 'email digest', 'budget review', 'go over',
        // he
        'ללמוד', 'לימודים', 'לחזור על', 'לקרוא', 'קריאה', 'מסמך', 'מסמכים', 'לסכם',
        'סיכום', 'סיכומים', 'לתכנן', 'תכנון', 'מחקר', 'להשוות', 'טופס', 'טפסים',
        'מצגת', 'שקפים', 'לכתוב פוסט', 'פוסט', 'לנסח', 'לעבור על', 'הערות',
    ],
    deep: [
        // en
        'code', 'coding', 'implement', 'refactor', 'debug', 'build', 'develop',
        'development', 'design', 'architecture', 'ship', 'deploy', 'write', 'writing',
        'essay', 'thesis', 'seminar', 'workout', 'gym', 'train', 'training', 'run',
        'running', 'exercise', 'project', 'exam prep', 'assignment', 'problem set',
        // he
        'קוד', 'לתכנת', 'תכנות', 'לפתח', 'פיתוח', 'לממש', 'ריפקטור', 'דיבוג', 'באג',
        'לבנות', 'לעצב', 'עיצוב', 'ארכיטקטורה', 'לכתוב', 'כתיבה', 'עבודה', 'סמינריון',
        'תרגיל', 'תרגילים', 'מבחן', 'מטלה', 'אימון', 'חדר כושר', 'לרוץ', 'ריצה',
        'להתאמן', 'פרויקט', 'שיעורי בית',
    ],
};

/** Explicit durations the user wrote into the title itself. */
const EXPLICIT_PATTERNS: { re: RegExp; minutes: (m: RegExpMatchArray) => number }[] = [
    // Fixed phrases first — they'd otherwise be missed by the numeric patterns.
    // NOTE: no \b around the Hebrew alternatives — JS word boundaries are ASCII-only,
    // so \bשעתיים\b can never match. Hebrew is matched as a plain substring.
    { re: /שעתיים|\btwo hours\b|\bcouple of hours\b/, minutes: () => 120 },
    { re: /חצי שעה|\bhalf an hour\b|\bhalf hour\b/, minutes: () => 30 },
    { re: /רבע שעה|\bquarter of an hour\b/, minutes: () => 15 },
    { re: /(\d+(?:[.,]\d+)?)\s*(?:h\b|hr\b|hrs\b|hours?\b|שעות|שעה)/, minutes: m => Math.round(parseFloat(m[1].replace(',', '.')) * 60) },
    { re: /(\d+)\s*(?:m\b|min\b|mins\b|minutes?\b|דקות|דק['׳]?)/, minutes: m => parseInt(m[1], 10) },
];

export interface DurationGuess {
    kind: TaskKind;
    minutes: number;
    /** Where the number came from — surfaced to the user so a bad guess is visible. */
    source: 'explicit' | 'keyword' | 'default';
    /** The keyword/phrase that decided it, for explainability. */
    matched?: string;
}

/** Is this an ASCII keyword? Hebrew has no \b support in JS regex. */
const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);

/**
 * Does `text` contain `kw`? ASCII keywords match on word boundaries (so "run"
 * doesn't fire on "running errands"→ well, it would on "running", which is the
 * point — but it won't fire on "brunch"). Hebrew matches as a substring, which
 * is what makes prefixed forms ("להתקשר" inside "צריך להתקשר") work.
 */
function contains(text: string, kw: string): boolean {
    if (!isAscii(kw)) return text.includes(kw);
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

/** Round to the nearest 5 minutes, clamped to something a calendar block can hold. */
export function normalizeMinutes(n: number): number {
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MINUTES;
    return Math.min(480, Math.max(5, Math.round(n / 5) * 5));
}

/**
 * Infer how long a task will take, and which bucket it belongs to.
 *
 * Resolution order:
 *   1. An explicit duration written in the title ("call mum for 10 min").
 *   2. The keyword bucket with the most hits; ties broken by the longest match,
 *      so a specific phrase beats a generic verb.
 *   3. The default focus block.
 */
export function inferDuration(title: string, notes?: string | null): DurationGuess {
    const text = `${title || ''} ${notes || ''}`.toLowerCase().trim();
    if (!text) return { kind: DEFAULT_KIND, minutes: DEFAULT_MINUTES, source: 'default' };

    for (const p of EXPLICIT_PATTERNS) {
        const m = text.match(p.re);
        if (m) {
            const minutes = normalizeMinutes(p.minutes(m));
            return { kind: kindForMinutes(minutes), minutes, source: 'explicit', matched: m[0].trim() };
        }
    }

    let best: { kind: TaskKind; hits: number; longest: number; matched: string } | null = null;
    for (const kind of Object.keys(KEYWORDS) as TaskKind[]) {
        let hits = 0, longest = 0, matched = '';
        for (const kw of KEYWORDS[kind]) {
            if (!contains(text, kw)) continue;
            hits++;
            if (kw.length > longest) { longest = kw.length; matched = kw; }
        }
        if (!hits) continue;
        // Longest specific match wins first; hit count is only the tie-breaker.
        // (A single "לכתוב פוסט" should beat two vague deep-work verbs.)
        if (!best || longest > best.longest || (longest === best.longest && hits > best.hits)) {
            best = { kind, hits, longest, matched };
        }
    }

    if (best) return { kind: best.kind, minutes: KIND_MINUTES[best.kind], source: 'keyword', matched: best.matched };
    return { kind: DEFAULT_KIND, minutes: DEFAULT_MINUTES, source: 'default' };
}

/** Reverse mapping — which bucket does an explicit duration belong to? */
export function kindForMinutes(minutes: number): TaskKind {
    if (minutes <= 20) return 'quick';
    if (minutes <= 40) return 'chore';
    if (minutes <= 70) return 'focus';
    return 'deep';
}
