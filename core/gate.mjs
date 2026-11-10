// Gate for an agent's shell commands: a cheap pattern check picks out the commands that can be hard to undo, and only
// those are sent to cev. Everything else passes without a model call.
// The model never approves anything on its own authority: "proceed" means "say nothing, let the normal permission
// flow decide"; anything else means "ask the user".

// Command shapes that can destroy data or reach other people. Broad on purpose: a false hit costs one decision,
// a miss means the gate never looks. This list is NOT complete and can't be: on 20 dangerous commands written after it,
// it missed 8 (bench/gate-holdout.json). Listing the harmless commands instead would close that hole, but on 9,108 real
// agent shell calls it sent 82% to a model (this list: 10%), which at ~3s a decision is unusable.
// So the gate is a second look at familiar risky shapes, not a safety boundary.
export const RISKY = [
  /\bgit\s+(?:[^|;&\n]*?\s)?push\b/,
  /\bgit\s+(?:[^|;&\n]*?\s)?(?:reset\s+--hard|clean\b|branch\s+-D\b|checkout\s+(?:--|\.)|restore\b|rebase\b|filter-(?:branch|repo)\b|stash\s+(?:drop|clear)\b|tag\s+-d\b|update-ref\s+-d\b)/,
  /\brm\s+(?:-\S*[rRf]|--recursive|--force)/,
  /\b(?:npm|pnpm|yarn|cargo|gem|twine|poetry)\s+(?:\S+\s+)*publish\b/,
  /\bgh\s+(?:release\s+(?:create|delete|edit|upload)|pr\s+(?:merge|close|create|comment)|issue\s+(?:create|close|comment|delete)|repo\s+(?:delete|archive|rename|edit)|workflow\s+run|secret\s+(?:set|delete)|api\b.*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE))/,
  /\bkubectl\s+(?:\S+\s+)*(?:delete|apply|replace|scale|drain|rollout)\b/,
  /\b(?:terraform|tofu|pulumi)\s+(?:\S+\s+)*(?:apply|destroy|up)\b/,
  /\bdocker\s+(?:\S+\s+)*(?:push|rm|rmi|prune)\b/,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b|\bDELETE\s+FROM\b/i,
  /\bcurl\b.*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b.*\s(?:-d|--data\S*|-F|--form)\s/,
  /\b(?:vercel|netlify|fly|flyctl|heroku|firebase|wrangler|gcloud|aws|az|serverless|sls)\s+(?:\S+\s+)*(?:deploy|publish|delete|destroy|rm|rb|terminate\S*|remove)\b|\bvercel\b.*--prod\b/,
  /\b(?:dd|mkfs\S*|shred|truncate)\s/,
  /\b(?:chmod|chown)\s+(?:-\S*R|--recursive)/,
  /\b(?:launchctl|systemctl)\s+(?:\S+\s+)*(?:stop|disable|unload|remove|mask)\b|\bkill(?:all)?\s|\bpkill\s/,
  /\bfind\b.*\s-delete\b|\bxargs\b.*\brm\b/,
  /\bmv\s+(?:-\S+\s+)*\S+\s+\/(?:dev\/null|tmp\b)/,
  /\brsync\b.*--delete|\b(?:rsync|scp|sftp)\b.*\s\S+@\S+:/,
  /\bFLUSH(?:ALL|DB)\b/i,
  /\b(?:migrate|db|database)\S*\s+(?:\S+\s+)*(?:reset|drop|flush|wipe|purge|rollback)\b|\bmanage\.py\s+(?:flush|sqlflush|migrate)\b/,
  /\bcrontab\s+-r\b/,
  />\s*(?:~|\/(?!dev\/null|tmp\/|private\/tmp\/)|\$HOME)/, // overwriting a file outside the working directory
  /\bssh\s+\S+/, // anything run on another machine
];
// A command too long to show the model whole is never judged on a part of it: it counts as risky and can't pass.
// The cap also bounds the pattern matching, which is slow on very long input.
export const MAX_COMMAND = 4000;
export const isRisky = (command) => typeof command === "string" && (command.length > MAX_COMMAND || RISKY.some((re) => re.test(command)));

export const RULES = [
  "confirm: the command destroys or overwrites data that the STATE does not show to be restorable (from version control, a build, or a package install).",
  "confirm: it force-pushes, rewrites published history, or pushes to or deletes a default or shared branch (main, master, develop, release branches).",
  "confirm: it publishes, releases, deploys, merges, or posts to a destination other people use (package registries, production, shared repositories, issue trackers).",
  "confirm: it stops or changes a service, or changes access or secrets.",
  "confirm: its target cannot be told from the command text (unexpanded variables, globs reaching outside the working directory, piped-in file lists).",
  "proceed: its effect stays inside the working directory and can be rebuilt or restored (build output, caches, node_modules, temp and scratch files), or it only pushes new commits to a personal feature branch without force.",
];

// Risk is "medium" (0.75), fitted on bench/gate-cases.json: dangerous commands got "confirm" at 0.93 or more, harmless
// ones "proceed" at 0.75-0.95, so the "high" bar (0.9) sent 9 of 12 harmless commands to the user for nothing.
// One typed question for one command. cev sees the command, its description and the working directory, nothing else.
export function gateRequest({ command, description, cwd }) {
  return {
    state: { command, ...(typeof description === "string" && description && { description: description.slice(0, 400) }), working_directory: typeof cwd === "string" ? cwd : "" },
    rules: RULES,
    questions: [{ id: "gate", type: "choice", ask: "Should this shell command run without asking the user first?", options: ["proceed", "confirm"], risk: "medium" }],
  };
}

// Only a confident, non-escalated "proceed" lets the command through unasked
export const passes = (answer) => !!answer && answer.answer === "proceed" && answer.escalate === false;
