# Start Here

## Recommended Codex setup

- Open this folder as a new Codex project.
- Start a new chat in the project.
- Select **GPT-5.6 Sol** with **Ultra** reasoning.
- Do **not** start in Plan mode. The goal and completion contract are already concrete in `GOAL.md`; Goal mode will maintain continuity while the agent plans and executes.
- Paste the command below as the first message.

## Opening prompt

```text
/goal Build the strongest practical local-first 3-player Bhabhi / Getaway live solver described in GOAL.md. First read GOAL.md completely, inspect the project, and treat its outcomes, invariants, phase gates, and final release criteria as the completion contract. This folder is the project root; if it contains only goal documents, initialize the implementation here. Use GPT-5.6 Sol Ultra subagents for clearly independent research, test design, benchmark analysis, and review work when useful; avoid overlapping writes and synthesize all results in the primary thread. Maintain docs/progress.md and execute phase gates in dependency order. You are authorized to create and edit project files, install project-local dependencies, browse public sources, and run non-destructive tests and benchmarks. Do not deploy, publish, spend money, or perform external writes without explicit approval. Resolve routine engineering choices autonomously. Pause only for a genuinely blocking household-rule decision, unavailable credential or permission, destructive action, or material scope expansion. Never invent research or benchmark results. Do not mark the goal complete until every GOAL.md release gate passes, or a true blocker is documented with evidence and the smallest required user decision. Begin now with repository assessment, rules research, and the preregistered evaluation plan, then continue through implementation and validation.
```

## While it runs

- Keep the work in the same task so the goal retains its context.
- Use the goal progress row to pause, resume, edit, or clear it.
- Send a follow-up in the same task to add a constraint or correct direction.
- Use a side chat for a status recap or explanation when you do not want to interrupt the active goal.
- If Codex pauses for an approval or genuine rule decision, answer it; Goal mode does not expand permissions on its own.
- Avoid running another task that writes to the same project folder at the same time.

## If you intentionally want a planning review first

Plan mode is optional, not recommended for the normal launch. Use it only if you want to change the product scope or household rules before implementation. In that case:

1. enter `/plan`;
2. ask Codex to inspect `GOAL.md` and interview you only about decisions that would materially change the product;
3. update `GOAL.md` with the agreed changes;
4. leave Plan mode and start the `/goal` prompt above.
