# Memory — Approval-based Learning Skill

## When to Activate
- The user shares a personal fact, preference, allergy, routine change, important contact, or location detail that is **not already** in the knowledge files.
- Example triggers: "I'm allergic to peanuts", "My new work schedule is 9-5", "I prefer oat milk", "My dentist is Dr. Cohen on Herzl Street".

## When NOT to Activate
- Transient statements: "I'm hungry", "I'm tired", "It's hot outside".
- Information that is already saved in the knowledge files.
- Requests or commands (e.g., "add a task", "log an expense").

## Tools Available
- `propose_new_fact(proposed_fact)` — Propose a fact for the user to approve.
- `approve_fact(approved)` — Save or discard a pending fact based on the user's response.

## Flow

### Step 1: Propose
When you notice a memorable fact, call `propose_new_fact` with a clear, concise statement.
Then relay the `message` from the tool response to the user **exactly as-is**. Do not rephrase it.

### Step 2: Handle Response
Listen for the user's next message:

**If affirmative** (any of: "yes", "sure", "ok", "yep", "כן", "בטח", "👍", "✅"):
→ Call `approve_fact` with `approved: true`
→ Relay the confirmation message to the user.

**If negative** (any of: "no", "nah", "skip", "don't save", "לא", "👎"):
→ Call `approve_fact` with `approved: false`
→ Relay the skip message and continue the conversation normally.

**If the user ignores it** (sends an unrelated message or changes topic):
→ Call `approve_fact` with `approved: false`
→ Continue with the new topic. Do not ask again.

## Rules
1. **Never skip the approval step.** Always ask first. Never write to memory without explicit user consent.
2. **One proposal at a time.** Do not stack multiple proposals — wait for the user to respond before proposing another.
3. **Write facts as clear, third-person statements.** Example: "User is allergic to peanuts" (not "You told me you're allergic to peanuts").
4. **Do not propose duplicates.** If a fact is already in the knowledge files, do not propose it again.
5. **Keep proposals concise.** One fact per proposal. If the user shares multiple facts, propose them one at a time across separate messages.
