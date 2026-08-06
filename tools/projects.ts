import {
    addProject, getProjects, completeProject, deleteProject, resolveProjectId,
    addTask, getPendingTasks, todayStr,
    type ProjectRow,
} from './storage';

/**
 * Projects ("missions") — a named objective that owns tasks.
 *
 * Schema: projects(id INTEGER PK, name TEXT, description TEXT, target_date TEXT,
 *                  status TEXT, created_at, completed_at)
 * Tasks point at a project via tasks.project_id.
 *
 * Progress is always DERIVED from the linked tasks (see getProjects), never
 * stored. A stored counter would drift the moment a task is completed or deleted
 * through any other path, and there are several.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseTargetDate(v: any): string | null {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (ISO_DATE.test(s)) return s;
    if (s === 'today') return todayStr();
    return null;
}

/** Compact progress line: "Dynamics exam — 4/9 done · 5 days left". */
function fmtProject(p: ProjectRow): string {
    const bits: string[] = [`#${p.id} ${p.name}`];
    bits.push(p.total ? `${p.done}/${p.total} done` : 'no tasks yet');

    if (p.target_date) {
        if (p.days_left === null) bits.push(p.target_date);
        else if (p.days_left < 0) bits.push(`⚠️ ${Math.abs(p.days_left)}d overdue (${p.target_date})`);
        else if (p.days_left === 0) bits.push(`🔴 due today`);
        else bits.push(`${p.days_left}d left (${p.target_date})`);
    }
    return bits.join(' · ');
}

export const projectTools = {
    add_project: {
        name: "add_project",
        description: "Create a project/mission — a named objective that tasks can be filed under.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Project name, e.g. 'Dynamics exam'" },
                target_date: { type: "string", description: "Target/deadline date as YYYY-MM-DD. Omit if open-ended." },
                description: { type: "string", description: "What finishing this project means." },
            },
            required: ["name"]
        },
        execute: async (args: any) => {
            try {
                const target = parseTargetDate(args.target_date);
                const p = addProject(args.name, target, args.description ?? null);
                let message = `Project #${p.id} created: "${p.name}"`;
                if (target) message += ` (target ${target})`;
                return { status: "success", projectId: p.id, message };
            } catch (err: any) {
                console.error("[Projects] Error adding project:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_projects: {
        name: "list_projects",
        description: "List projects/missions with progress and time left.",
        parameters: {
            type: "object",
            properties: {
                include_completed: { type: "boolean", description: "Include finished projects (default false)" },
            }
        },
        execute: async (args: any = {}) => {
            try {
                const projects = getProjects(!!args.include_completed);
                if (!projects.length) return { status: "success", count: 0, message: "No projects yet." };
                return {
                    status: "success",
                    count: projects.length,
                    message: projects.map(fmtProject).join('\n'),
                };
            } catch (err: any) {
                console.error("[Projects] Error listing projects:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    project_status: {
        name: "project_status",
        description: "Show one project with its remaining tasks.",
        parameters: {
            type: "object",
            properties: {
                project: { type: "string", description: "Project name or id" },
            },
            required: ["project"]
        },
        execute: async (args: any) => {
            try {
                const id = resolveProjectId(args.project);
                if (id === null) return { status: "error", error: `No project matched "${args.project}".` };

                const p = getProjects(true).find(x => x.id === id);
                if (!p) return { status: "error", error: "Project not found." };

                const open = getPendingTasks('all').filter(t => t.project_id === id);
                const lines = [fmtProject(p)];
                if (p.description) lines.push(p.description);
                lines.push(open.length ? '' : '\nNothing left open.');
                for (const t of open) {
                    lines.push(`  ${t.id} ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`);
                }
                return { status: "success", message: lines.join('\n').trim() };
            } catch (err: any) {
                console.error("[Projects] Error reading project:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    breakdown_project: {
        name: "breakdown_project",
        description: "Add several tasks at once under a project — use to split a mission into concrete steps.",
        parameters: {
            type: "object",
            properties: {
                project: { type: "string", description: "Project name or id" },
                tasks: {
                    type: "array",
                    description: "The steps to create, in order.",
                    items: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Step description" },
                            due_date: { type: "string", description: "YYYY-MM-DD, optional" },
                            estimate_minutes: { type: "number", description: "Rough minutes, optional" },
                            priority: { type: "string", enum: ["high", "medium", "low"] },
                        },
                        required: ["title"],
                    },
                },
            },
            required: ["project", "tasks"]
        },
        execute: async (args: any) => {
            try {
                const id = resolveProjectId(args.project);
                if (id === null) return { status: "error", error: `No project matched "${args.project}".` };

                const items: any[] = Array.isArray(args.tasks) ? args.tasks : [];
                if (!items.length) return { status: "error", error: "No tasks supplied." };

                const created: string[] = [];
                for (const it of items) {
                    if (!it || !it.title) continue;
                    const due = it.due_date && ISO_DATE.test(String(it.due_date)) ? String(it.due_date) : null;
                    const r = addTask(String(it.title), it.priority || 'medium', {
                        dueDate: due,
                        estimateMinutes: it.estimate_minutes ?? null,
                        projectId: id,
                    });
                    created.push(r.id);
                }
                if (!created.length) return { status: "error", error: "No valid tasks in the list." };
                return {
                    status: "success",
                    created: created.length,
                    message: `Added ${created.length} task(s) to project #${id}: ${created.join(', ')}`,
                };
            } catch (err: any) {
                console.error("[Projects] Error breaking down project:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    complete_project: {
        name: "complete_project",
        description: "Mark a project/mission as finished.",
        parameters: {
            type: "object",
            properties: { project: { type: "string", description: "Project name or id" } },
            required: ["project"]
        },
        execute: async (args: any) => {
            try {
                const ok = completeProject(args.project);
                return ok
                    ? { status: "success", message: "Project marked complete. 🎉" }
                    : { status: "error", error: `No project matched "${args.project}".` };
            } catch (err: any) {
                console.error("[Projects] Error completing project:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    delete_project: {
        name: "delete_project",
        description: "Delete a project. Its tasks are kept, just unfiled.",
        parameters: {
            type: "object",
            properties: { project: { type: "string", description: "Project name or id" } },
            required: ["project"]
        },
        execute: async (args: any) => {
            try {
                const ok = deleteProject(args.project);
                return ok
                    ? { status: "success", message: "Project deleted; its tasks were kept and unfiled." }
                    : { status: "error", error: `No project matched "${args.project}".` };
            } catch (err: any) {
                console.error("[Projects] Error deleting project:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
