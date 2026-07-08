#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin as input } from 'node:process';
import { pathToFileURL } from 'node:url';

export const TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS = Object.freeze({
  telegramPolled: false,
  telegramMessagesSent: false,
  telegramStateWrites: false,
  approvalDecisionWrites: false,
  offsetWrites: false,
  workerExecuted: false,
  githubCalls: false,
  githubWrites: false,
  obsidianKanbanWrites: false,
  auditWrites: false,
  durableStoreWrites: false,
  reportWrites: false,
  indexWrites: false,
  systemdServiceChanges: false,
  staged: false,
  committed: false,
  pushed: false,
});

const SECRET_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /gh[pousr]_[A-Za-z0-9_]{20,}/gi,
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,
  /sk-[A-Za-z0-9_-]{16,}/gi,
  /xox[baprs]-[A-Za-z0-9-]{16,}/gi,
  /(["']?(?:token|secret|password|api[_-]?key|client[_-]?secret|chat[_-]?id)["']?\s*[:=]\s*)["']?[^\s,'"}]+["']?/gi,
  /\bchat[_-]?id\s+[-]?\d{5,}\b/gi,
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--update-json') args.updateJson = argv[++i];
    else if (arg === '--registered-chat-id') args.registeredChatId = argv[++i];
    else args._.push(arg);
  }
  return args;
}

function requireJson(args) {
  if (!args.json) throw new Error('telegram-update-router-preview is intentionally JSON-only. Pass --json.');
}

export function redactTelegramRouterText(value, cap = 2000) {
  let text = String(value ?? '').replace(/\u0000/g, '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...match) => (match[1] ? `${match[1]}[REDACTED]` : '[REDACTED]'));
  }
  return text.slice(0, cap);
}

function safeErrorMessage(error) {
  return redactTelegramRouterText(error?.message || error || 'unknown error', 500);
}

function resolveRegisteredChatId({ registeredChatId, env = process.env } = {}) {
  return registeredChatId || env.HERMES_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID || null;
}

function extractMessage(update) {
  return update?.message || update?.edited_message || update?.channel_post || null;
}

function extractText(update) {
  const message = extractMessage(update);
  return typeof message?.text === 'string' ? message.text : null;
}

function extractChatId(update) {
  const message = extractMessage(update);
  const chatId = message?.chat?.id;
  return chatId === null || chatId === undefined ? null : String(chatId);
}

function baseRoute(update, status, extra = {}) {
  return {
    ok: true,
    preview_only: true,
    router: 'telegram_update_router_preview',
    update_id: Number.isSafeInteger(update?.update_id) ? update.update_id : null,
    message_id: extractMessage(update)?.message_id ?? null,
    status,
    chat_id_redacted: extractChatId(update) ? '[REDACTED]' : null,
    registered_chat_verified: false,
    ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
    ...extra,
  };
}

function parseApprovalCommand(text) {
  const match = String(text || '').trim().match(/^\/(approve|reject)\s+([A-Za-z0-9_-]+)$/i);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    decision: match[1].toLowerCase() === 'approve' ? 'approved' : 'rejected',
    approval_id_or_alias: redactTelegramRouterText(match[2], 200),
  };
}

function unsafeReasonForText(text) {
  const normalized = String(text || '').toLowerCase();
  if (/ignore (all )?(previous|prior|system|developer) instructions|bypass approvals?|override safety|jailbreak|prompt injection/.test(normalized)) {
    return 'PROMPT_INJECTION_OR_APPROVAL_BYPASS';
  }
  if (/\b(rm\s+-rf|delete\s+(all|the)?\s*(files|data|database|repo)|drop\s+database|wipe\s+(disk|data)|format\s+(disk|drive))\b/.test(normalized)) {
    return 'DESTRUCTIVE_REQUEST_REQUIRES_EXPLICIT_APPROVAL';
  }
  if (/\b(stop|restart|disable|enable)\b.*\b(service|systemd|hermes-gateway\.service)\b/.test(normalized)) {
    return 'SERVICE_CHANGE_REQUIRES_EXPLICIT_APPROVAL';
  }
  if (/\b(send|message|email|contact)\b.*\b(customer|seller|telegram|discord|client)\b/.test(normalized)) {
    return 'EXTERNAL_CONTACT_REQUIRES_EXPLICIT_APPROVAL';
  }
  return null;
}

export function classifyNaturalLanguageTaskIntake(text) {
  const raw_text_redacted = redactTelegramRouterText(text);
  const normalized = String(text || '').trim().toLowerCase();
  const unsafeReason = unsafeReasonForText(normalized);
  if (unsafeReason) {
    return {
      raw_text_redacted,
      intent_type: 'unsafe_or_needs_clarification',
      requested_action: 'blocked_preview_only',
      risk_level: 'high',
      approval_required: true,
      missing_clarifications: [unsafeReason],
      safe_summary_for_telegram: 'Blocked for safety: needs explicit clarification/approval before any action.',
    };
  }
  if (!normalized || /^(fix it|do it|handle this|make it better)$/.test(normalized)) {
    return {
      raw_text_redacted,
      intent_type: 'unsafe_or_needs_clarification',
      requested_action: 'clarify_scope',
      risk_level: 'medium',
      approval_required: true,
      missing_clarifications: ['REQUEST_TOO_VAGUE'],
      safe_summary_for_telegram: 'Needs clarification before routing.',
    };
  }
  if (/\b(research|investigate|find|compare|look up|survey)\b/.test(normalized)) {
    return {
      raw_text_redacted,
      intent_type: 'research',
      requested_action: 'research_preview',
      risk_level: 'medium',
      approval_required: true,
      missing_clarifications: [],
      safe_summary_for_telegram: `Research request preview: ${raw_text_redacted}`,
    };
  }
  if (/\b(build|implement|code|module|feature|app|component|fix|patch|edit|refactor)\b/.test(normalized)) {
    return {
      raw_text_redacted,
      intent_type: 'code_change',
      requested_action: 'code_change_approval_packet_preview',
      risk_level: 'high',
      approval_required: true,
      missing_clarifications: [],
      safe_summary_for_telegram: `Code-change request preview: ${raw_text_redacted}`,
    };
  }
  if (/\b(capture|save|record|note|idea)\b/.test(normalized)) {
    return {
      raw_text_redacted,
      intent_type: 'obsidian_capture',
      requested_action: 'obsidian_capture_preview',
      risk_level: 'medium',
      approval_required: true,
      missing_clarifications: [],
      safe_summary_for_telegram: `Capture request preview: ${raw_text_redacted}`,
    };
  }
  if (/\b(status|progress|what happened|where are we)\b/.test(normalized)) {
    return {
      raw_text_redacted,
      intent_type: 'status',
      requested_action: 'status_preview',
      risk_level: 'low',
      approval_required: false,
      missing_clarifications: [],
      safe_summary_for_telegram: `Status request preview: ${raw_text_redacted}`,
    };
  }
  return {
    raw_text_redacted,
    intent_type: 'question',
    requested_action: 'answer_preview',
    risk_level: 'low',
    approval_required: false,
    missing_clarifications: [],
    safe_summary_for_telegram: `Question preview: ${raw_text_redacted}`,
  };
}

export function routeTelegramUpdatePreview(update, { registeredChatId } = {}) {
  const resolvedChatId = registeredChatId == null ? null : String(registeredChatId);
  if (!resolvedChatId) {
    return baseRoute(update, 'blocked', {
      reason: 'REGISTERED_CHAT_ID_REQUIRED',
      missing_clarifications: ['REGISTERED_CHAT_ID_REQUIRED'],
    });
  }

  const updateChatId = extractChatId(update);
  if (updateChatId !== resolvedChatId) {
    return baseRoute(update, 'ignored', {
      reason: 'WRONG_CHAT',
      ignored: true,
      chat_id_redacted: updateChatId ? '[REDACTED]' : null,
    });
  }

  const text = extractText(update);
  if (text === null) {
    return baseRoute(update, 'ignored', {
      reason: 'NON_TEXT_MESSAGE',
      ignored: true,
      registered_chat_verified: true,
    });
  }

  const approvalCommand = parseApprovalCommand(text);
  if (approvalCommand) {
    return baseRoute(update, 'routed', {
      route_type: 'approval_command',
      classification: 'approval_command',
      registered_chat_verified: true,
      approval_id_or_alias: approvalCommand.approval_id_or_alias,
      decision_preview: approvalCommand.decision,
      approvalDecisionWrites: false,
      safe_summary_for_telegram: `${approvalCommand.command} command preview accepted. No decision state written.`,
    });
  }

  const classification = classifyNaturalLanguageTaskIntake(text);
  return baseRoute(update, 'routed', {
    route_type: classification.intent_type === 'unsafe_or_needs_clarification' ? 'unsafe_or_needs_clarification' : 'natural_language_task_intake',
    classification: classification.intent_type,
    registered_chat_verified: true,
    ...classification,
  });
}

function updatesFromParsedJson(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.result)) return parsed.result;
  return [parsed];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function loadUpdateJson(args) {
  const content = args.updateJson ? await readFile(args.updateJson, 'utf8') : await readStdin();
  if (!content.trim()) throw new Error('No Telegram update JSON provided. Use --update-json <file> or pipe JSON on stdin.');
  return JSON.parse(content);
}

export async function runTelegramUpdateRouterPreviewCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  requireJson(args);
  const parsed = await loadUpdateJson(args);
  const registeredChatId = resolveRegisteredChatId({ registeredChatId: args.registeredChatId, env });
  const routes = updatesFromParsedJson(parsed).map((update) => routeTelegramUpdatePreview(update, { registeredChatId }));
  const result = {
    ok: true,
    preview_only: true,
    input: args.updateJson ? 'file' : 'stdin',
    route_count: routes.length,
    routes,
    ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramUpdateRouterPreviewCli().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
