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
  // Added in 1.3.0 from the shapes the holdout set showed were missed (so that set no longer measures unseen commands)
  /\bhelm\s+(?:\S+\s+)*(?:install|upgrade|uninstall|delete|rollback)\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:\S+\s+)*unpublish\b/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  /\bdocker(?:-compose|\s+compose)\s+(?:\S+\s+)*down\b/,
  /\bdropDatabase\s*\(|\.drop\s*\(\s*\)/,
];
// A command too long to show the model whole is never judged on a part of it: it counts as risky and can't pass.
// The cap also bounds the pattern matching, which is slow on very long input.
export const MAX_COMMAND = 4000;
export const isRisky = (command) => typeof command === "string" && (command.length > MAX_COMMAND || RISKY.some((re) => re.test(command)));

// Shapes that are asked about without a model call: nothing in the command text could make them safe to run unasked,
// and a fixed rule gives the user a plain reason at once. Deliberately few. Everything else risky goes to the model.
const PUSH = String.raw`\bgit\s+(?:[^|;&\n]*?\s)?push\b[^|;&\n]*?\s`;
export const ALWAYS_ASK = [
  [new RegExp(PUSH + String.raw`(?:--force(?:-with-lease\S*)?(?=\s|$)|-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|["']?\+\S+)`), "it force-pushes, which overwrites history on the remote"],
  [new RegExp(PUSH + String.raw`(?:--delete(?=\s|$)|-[a-zA-Z]*d[a-zA-Z]*(?=\s|$)|["']?:\S+|--mirror(?=\s|$)|--prune(?=\s|$))`), "it deletes a branch or tag on the remote"],
  [/\bgit\s+(?:[^|;&\n]*?\s)?filter-(?:branch|repo)\b/, "it rewrites the repository's history"],
  [/\brm\s+(?:-\S+\s+)*(?:--\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\})\/?["']?(?:\s|$)/, "it removes the home or root directory"],
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b/i, "it drops or empties a database object"],
  [/\b(?:terraform|tofu|pulumi)\s+(?:\S+\s+)*destroy\b/, "it destroys infrastructure"],
  [/\bmkfs\S*\s|\bdd\b[^|;&\n]*\bof=\/dev\//, "it overwrites a disk"],
];
// A command that only prints text (echo or printf with nothing chained or substituted) runs none of what it mentions
const ONLY_PRINTS = /^\s*(?:echo|printf)\b[^;|&`$<>\n\r]*$/;
export const alwaysAsk = (command) => (ONLY_PRINTS.test(command) ? null : ALWAYS_ASK.find(([re]) => re.test(command))?.[1] ?? null);

// The question is whether the command can be undone, not whether it is important. A normal push to any branch can be
// reverted, and agents make them all day; asking about each one made the gate something to switch off.
export const RULES = [
  "data: the command destroys or overwrites data that the STATE does not show to be restorable (from version control, a build, or a package install).",
  "history: it force-pushes, rewrites published history, or deletes a branch or tag on a remote.",
  "release: it publishes a package, cuts a release, deploys, merges a pull request, or posts a comment, issue or message, to a destination other people use. A plain git push is not a release.",
  "access: it stops or changes a service, or changes access or secrets.",
  "target: its target cannot be told from the command text (unexpanded variables, globs reaching outside the working directory, piped-in file lists).",
  "proceed: its effect stays inside the working directory and can be rebuilt or restored (build output, caches, node_modules, temp and scratch files), or it pushes commits without force to any branch (a pushed commit can be reverted).",
];
// What the user is told when the model picks a reason to confirm
export const REASONS = {
  data: "it may destroy data that can't be restored",
  history: "it rewrites or deletes history on a remote",
  release: "it publishes, deploys, merges or posts to a place other people use",
  access: "it changes a service, access or secrets",
  target: "its target can't be told from the command",
};

// Risk is "medium" (0.75), fitted on bench/gate-cases.json.
// One typed question for one command. cev sees the command, its description and the working directory, nothing else.
// Each reason to confirm is its own option, so the answer says why; only "proceed" lets the command through.
export function gateRequest({ command, description, cwd }) {
  return {
    state: { command, ...(typeof description === "string" && description && { description: description.slice(0, 400) }), working_directory: typeof cwd === "string" ? cwd : "" },
    rules: RULES,
    questions: [{ id: "gate", type: "choice", ask: "Should this shell command run without asking the user first? Answer proceed, or the rule that says to confirm.", options: ["proceed", ...Object.keys(REASONS)], risk: "medium" }],
  };
}

// Only a confident, non-escalated "proceed" lets the command through unasked
export const passes = (answer) => !!answer && answer.answer === "proceed" && answer.escalate === false;
