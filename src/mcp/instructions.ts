// The protocol that travels with the server (spec B5): what an agent reads when it connects, under
// 2 000 characters, and the two guides a person can invoke.
import { AGENT_ENTRY_TYPES } from './tools.ts'

export const INSTRUCTIONS = `rsc-brain is a shared memory for you and the people you work with. Use it like this:

1. Start: if you work in a repository, call brain_resolve with its remote (git remote get-url origin), then mem_context for that brain. Read it before you plan.
2. Search before you decide: mem_search. The brain knows things you do not: past decisions, failed attempts, the person's preferences.
3. Write while you work: mem_save each decision with its why, each learning, each failed attempt, and anything the person corrects (as a "learning"; "correction" is only for people). Types: ${AGENT_ENTRY_TYPES.join(', ')}. Use a topic for what evolves, so it is revised instead of duplicated. Start with mem_session_start and pass its session to later calls.
4. Never save secrets: no keys, passwords or tokens. Wrap anything private in <private>...</private>.
5. Close: mem_session_summary with goal, done, discovered, decided and pending.
6. If asked to compile, use brain_compile_pack (it shows each operation with an example), then brain_propose: it applies at once, with undo, and a curator reviews it later; parts on protected pages or against a correction wait, parts on an old revision come back to redo. If a curator let your key write to the wiki, brain_write writes directly, brain_review then brain_decide decide what waits, and brain_changes and brain_undo review what changed. Do not invent: cite the entries you use. Read the warnings and the linked pages each answer brings (brain_check asks first) and fix contradictions.
7. When mem_context brings a cleanup, fix what its report lists and send it with "maintenance": true.

Every error says what happened and how to proceed. A brain you cannot use answers as if it did not exist.`

export type PromptDef = {
  name: string
  title: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
  text: (args: Record<string, string>) => string
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'compile_brain',
    title: 'Compile this brain',
    description:
      'Turn what the journal learned into changes to the wiki, applied at once for a person to review.',
    arguments: [{ name: 'brain', description: 'The brain to compile (its name).', required: false }],
    text: (a) =>
      [
        `Compile the brain${a.brain ? ` "${a.brain}"` : ''} into its wiki.`,
        '1. Call brain_compile_pack to get the pending entries, corrections, map, related pages and the guide.',
        '2. Follow the guide. Group entries into pages: create, update, link, move or retire. Cite the entries each change comes from. Do not invent anything the entries do not say.',
        '3. Entries that change nothing go in "collected".',
        '4. Send it with brain_propose. Fix the problems it reports and send again.',
        '5. Tell the person what applied (it is undoable from «Review later»), what waits for a curator and why, and redo what came back on the current page.',
      ].join('\n'),
  },
  {
    name: 'close_session',
    title: 'Close my session',
    description: 'Write the summary of this working session to the brain and close it.',
    arguments: [{ name: 'session', description: 'The session id from mem_session_start.', required: false }],
    text: (a) =>
      [
        `Close the brain session${a.session ? ` ${a.session}` : ''}.`,
        '1. Save anything not yet saved with mem_save: decisions with their why, learnings, failed attempts, corrections from the person (as "learning").',
        '2. Call mem_session_summary with: Goal, Done, Discovered, Decided, Pending. Short and concrete.',
        '3. Tell the person it is saved.',
      ].join('\n'),
  },
]
