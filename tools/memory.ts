import { addPendingFact, getActivePendingFact, resolvePendingFact, appendToLearnedFacts } from './storage';

/**
 * Memory Tools — Approval-based Append-Only Learning
 *
 * Allows Astra to propose new facts/preferences learned from conversation.
 * Facts are NOT saved immediately — the user must approve via WhatsApp first.
 *
 * Flow:
 *   1. Astra calls propose_new_fact → fact is stored as "pending" in SQLite
 *   2. Astra relays the confirmation prompt to the user
 *   3. User replies yes/no → Astra calls approve_fact
 *   4. If approved, the fact is appended to knowledge/learned_facts.md
 *
 * The pending_facts SQLite table is the source of truth for pending state.
 * learned_facts.md is strictly append-only (never read, edited, or truncated).
 */

export const memoryTools = {
    propose_new_fact: {
        name: "propose_new_fact",
        description: "Propose a new fact or preference to remember. This does NOT save immediately — it asks the user for approval first. Use this when you notice a personal preference, routine change, allergy, contact detail, or any fact the user might want you to recall in the future.",
        parameters: {
            type: "object",
            properties: {
                proposed_fact: {
                    type: "string",
                    description: "The fact or preference to remember, written as a clear, concise statement (e.g., 'User is allergic to peanuts', 'Preferred coffee: oat milk latte')"
                }
            },
            required: ["proposed_fact"]
        },
        execute: async (args: any) => {
            try {
                const pendingId = addPendingFact(args.proposed_fact);
                return {
                    status: "awaiting_approval",
                    pending_id: pendingId,
                    message: `🧠 I noticed a new detail. Would you like me to remember this?\n\n"${args.proposed_fact}"\n\nReply yes/כן/👍 to save, or no/לא to skip.`
                };
            } catch (err: any) {
                console.error("[Memory] Error proposing fact:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    approve_fact: {
        name: "approve_fact",
        description: "Approve or decline a previously proposed fact. Call this with approved=true when the user confirms (yes, sure, ok, כן, בטח, 👍, ✅). Call with approved=false when the user declines (no, לא, skip) or changes topic.",
        parameters: {
            type: "object",
            properties: {
                approved: {
                    type: "boolean",
                    description: "true to save the fact, false to discard it"
                }
            },
            required: ["approved"]
        },
        execute: async (args: any) => {
            try {
                const pending = getActivePendingFact();
                if (!pending) {
                    return {
                        status: "error",
                        error: "No pending fact awaiting approval."
                    };
                }

                const success = resolvePendingFact(pending.id, args.approved);
                if (!success) {
                    return { status: "error", error: "Failed to resolve pending fact." };
                }

                if (args.approved) {
                    appendToLearnedFacts(pending.proposed_fact);
                    return {
                        status: "saved",
                        message: "✅ Saved!"
                    };
                } else {
                    return {
                        status: "skipped",
                        message: "Okay, I won't remember that."
                    };
                }
            } catch (err: any) {
                console.error("[Memory] Error approving fact:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
