# SC-Main Seed Verification Build Kit

Copy these Markdown files into the project directory:

- `PRD_SEED_VERIFICATION.md` — product requirements and acceptance criteria.
- `AGENT_GUIDELINES.md` — non-negotiable coding-agent rules, testing discipline, and stop conditions.
- `BUILD_PROMPT.md` — the prompt/execution protocol to give the implementation agent.
- `SC_MAIN_INTEGRATED_ARCHITECTURE.md` — integrated architecture for current SC-Main + Seed Verification.

Recommended usage:

1. Put all four `.md` files at the project root.
2. Start the coding agent with the contents/instructions in `BUILD_PROMPT.md`.
3. Require the agent to finish Phase 0 first and wait for explicit approval.
4. Approve phases one at a time.
5. Never accept "green enough"; require the stated test commands to pass.
