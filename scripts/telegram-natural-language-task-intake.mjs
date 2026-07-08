#!/usr/bin/env node
import fs from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/gi,
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /bot\d+:[A-Za-z0-9_-]+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
  /(["']?(?:token|secret|password|api[_-]?key|client[_-]?secret|chat[_-]?id)["']?\s*[:=]\s*)["']?[^\s,'"}]+["']?/gi,
]

export const FORBIDDEN_SIDE_EFFECTS = Object.freeze({
  preview_only: true,
  execution: false,
  file_writes: false,
  github_calls: false,
  github_writes: false,
  telegram_sends: false,
  obsidian_writes: false,
  kanban_writes: false,
  audit_writes: false,
  durable_writes: false,
  report_writes: false,
  state_writes: false,
  systemd_changes: false,
})

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/[\t ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function redactTaskText(value) {
  let text = normalizeWhitespace(value)
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...match) => (match[1] ? `${match[1]}[REDACTED]` : '[REDACTED]'))
  }
  return text.length > 500 ? `${text.slice(0, 499).trim()}…` : text
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text))
}

function baseIntent(rawText) {
  return {
    ok: true,
    preview_only: true,
    raw_text_redacted: redactTaskText(rawText),
    intent_type: 'unsafe_or_needs_clarification',
    requested_action: 'clarify request',
    risk_level: 'medium',
    approval_required: true,
    proposed_next_cli: null,
    missing_clarifications: [],
    forbidden_side_effects: { ...FORBIDDEN_SIDE_EFFECTS },
    safe_summary_for_telegram: 'I can preview this request only. No action was taken.',
    side_effects: {
      executed: false,
      fileWrites: false,
      githubCalls: false,
      telegramSends: false,
      obsidianWrites: false,
      auditDurableReportStateWrites: false,
      systemdChanges: false,
    },
  }
}

function blocked(rawText, requestedAction, missingClarifications, summary, riskLevel = 'high') {
  const result = baseIntent(rawText)
  result.intent_type = 'unsafe_or_needs_clarification'
  result.requested_action = requestedAction
  result.risk_level = riskLevel
  result.approval_required = true
  result.missing_clarifications = missingClarifications
  result.safe_summary_for_telegram = summary
  return result
}

export function classifyTelegramNaturalLanguageTask(rawText) {
  const clean = normalizeWhitespace(rawText)
  const lower = clean.toLowerCase()

  if (!clean) {
    return blocked(rawText, 'empty request', ['Send the task text to classify.'], 'Blocked: no task text was provided.', 'low')
  }

  if (includesAny(lower, [/ignore (all )?(previous|approval|rules|instructions)/i, /bypass (approval|approvals|safety|rules)/i, /without approval/i, /do not ask/i, /override (approval|safety|policy)/i])) {
    return blocked(rawText, 'blocked prompt-injection or approval-bypass request', ['Remove approval-bypass instructions and send the real task scope.'], 'Blocked: the message tried to bypass approvals. No action was taken.')
  }

  if (includesAny(lower, [/\bdelete\b/i, /\brm\s+-rf\b/i, /\bdrop\b.*\btable\b/i, /\berase\b/i, /\bdestroy\b/i])) {
    return blocked(rawText, 'destructive file/data operation', ['Exact target paths/data scope.', 'Explicit destructive approval.', 'Rollback plan.'], 'Blocked: destructive requests need exact scope and explicit approval.')
  }

  if (includesAny(lower, [/\b(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/i]) && includesAny(lower, [/\b(edit|change|modify|update|write|patch)\b/i])) {
    return blocked(rawText, 'package file edit request', ['Exact package-file path.', 'Allowed package.json change.', 'Explicit package-file approval.'], 'Blocked: package-file edits require exact approval.')
  }

  if (includesAny(lower, [/^fix it$/i, /^do it$/i, /^make it better$/i, /^handle this$/i, /^sort it$/i, /^this is broken$/i])) {
    return blocked(rawText, 'vague task request', ['What system/file/feature is affected?', 'What outcome should be produced?', 'What side effects are approved?'], 'Needs clarification: the task is too vague to classify safely.', 'medium')
  }

  if (includesAny(lower, [/\b(status|progress|where are we|what happened|summary|report)\b/i])) {
    const result = baseIntent(rawText)
    result.intent_type = 'status'
    result.requested_action = 'status request'
    result.risk_level = 'low'
    result.approval_required = false
    result.proposed_next_cli = 'status/read-only check only'
    result.safe_summary_for_telegram = 'Status request previewed. Read-only status checks may be safe; no check was run here.'
    return result
  }

  if (includesAny(lower, [/\bresearch\b/i, /existing github projects/i, /find .*github/i, /look up/i])) {
    const result = baseIntent(rawText)
    result.intent_type = 'research'
    result.requested_action = 'research public sources'
    result.risk_level = includesAny(lower, [/github/i]) ? 'medium' : 'low'
    result.approval_required = true
    result.proposed_next_cli = 'public-github-discovery-worker --limit 3 --json (discovery only, after explicit approval)'
    result.safe_summary_for_telegram = 'Research intent detected. Proposed next step is discovery only; no GitHub call was made.'
    return result
  }

  if (includesAny(lower, [/\b(capture|save|record|note)\b.*\b(idea|thought|note|this)\b/i, /^capture this idea$/i])) {
    const result = baseIntent(rawText)
    result.intent_type = 'obsidian_capture'
    result.requested_action = 'capture idea/note'
    result.risk_level = 'medium'
    result.approval_required = true
    result.proposed_next_cli = 'obsidian-idea-intake --dry-run --json (preview only until approved)'
    result.safe_summary_for_telegram = 'Obsidian capture intent detected. Approval is required before any note/write.'
    return result
  }

  if (includesAny(lower, [/\b(build|implement|code|add|create|write|refactor|module|feature|edit)\b/i])) {
    const result = baseIntent(rawText)
    result.intent_type = 'code_change'
    result.requested_action = 'code change/build request'
    result.risk_level = 'high'
    result.approval_required = true
    result.proposed_next_cli = 'telegram-code-edit-approval-packet --json (exact scope approval required before edits)'
    result.missing_clarifications = ['Exact workspace/repo.', 'Exact files or approved discovery/build stage.', 'Tests/verification command.', 'Approval for code edits.']
    result.safe_summary_for_telegram = 'Code-change intent detected. High risk; exact approval is required before edits or commands.'
    return result
  }

  if (clean.endsWith('?') || includesAny(lower, [/^(what|why|how|when|where|who|can you explain)\b/i])) {
    const result = baseIntent(rawText)
    result.intent_type = 'question'
    result.requested_action = 'answer question'
    result.risk_level = 'low'
    result.approval_required = false
    result.proposed_next_cli = 'answer/read-only lookup if needed'
    result.safe_summary_for_telegram = 'Question intent detected. Answering may be safe; no lookup was run here.'
    return result
  }

  return blocked(rawText, 'unclassified request', ['Clarify whether this is status, research, code change, Obsidian capture, or a question.'], 'Needs clarification: I could not classify this safely.', 'medium')
}

function parseArgs(argv) {
  const args = { json: false, text: null, fixture: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--text') args.text = argv[++index]
    else if (arg === '--fixture') args.fixture = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unsupported argument: ${arg}`)
  }
  return args
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function runTelegramNaturalLanguageTaskIntakeCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write('Usage: telegram-natural-language-task-intake --json [--text TEXT | --fixture PATH]\n')
    return
  }
  if (!args.json) throw new Error('JSON-only CLI: pass --json')
  if (args.text && args.fixture) throw new Error('Use only one of --text or --fixture')

  const text = args.text ?? (args.fixture ? await fs.readFile(args.fixture, 'utf8') : await readStdin())
  const result = classifyTelegramNaturalLanguageTask(text)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramNaturalLanguageTaskIntakeCli().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, preview_only: true, error: String(error?.message || error), forbidden_side_effects: { ...FORBIDDEN_SIDE_EFFECTS } }, null, 2)}\n`)
    process.exitCode = 1
  })
}
