#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  routeTelegramUpdatePreview,
  redactTelegramRouterText,
} from './telegram-update-router-preview.mjs';

export const TELEGRAM_UPDATE_ROUTER_WORKER_SIDE_EFFECTS = Object.freeze({
  ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  telegramQueueStateWrites: false,
  outputJsonlWrites: false,
  liveGatewayChanges: false,
  approvalDecisionWrites: false,
  offsetWrites: false,
  codeEdits: false,
});

const REQUIRED_ROW_FIELDS = ['update_id', 'message_id', 'chat_id', 'text', 'received_at', 'source', 'sanitized'];

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--queue-jsonl') args.queueJsonl = argv[++index];
    else if (arg === '--output-jsonl') args.outputJsonl = argv[++index];
    else if (arg === '--registered-chat-id') args.registeredChatId = argv[++index];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return args;
}

function requireJson(args) {
  if (!args.json) throw new Error('telegram-update-router-worker is intentionally JSON-only. Pass --json.');
}

function validateExplicitPath(value, flagName) {
  if (!value || typeof value !== 'string') throw new Error(`${flagName} is required.`);
  if (value.includes('\u0000')) throw new Error(`${flagName} contains an invalid null byte.`);
  return path.resolve(value);
}

function parseQueueJsonl(content) {
  const rows = [];
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      rows.push({ line_number: index + 1, row: JSON.parse(line) });
    } catch (error) {
      const safeMessage = redactTelegramRouterText(error?.message || error, 300);
      throw new Error(`Malformed JSONL at line ${index + 1}: ${safeMessage}`);
    }
  }
  return rows;
}

function validateQueueRow(row, lineNumber) {
  const missing = REQUIRED_ROW_FIELDS.filter((field) => !(field in Object(row)));
  if (missing.length > 0) throw new Error(`Invalid queue row at line ${lineNumber}: missing ${missing.join(', ')}`);
  if (!Number.isSafeInteger(row.update_id)) throw new Error(`Invalid queue row at line ${lineNumber}: update_id must be a safe integer`);
  if (!Number.isSafeInteger(row.message_id)) throw new Error(`Invalid queue row at line ${lineNumber}: message_id must be a safe integer`);
  if (row.chat_id === null || row.chat_id === undefined || String(row.chat_id).trim() === '') throw new Error(`Invalid queue row at line ${lineNumber}: chat_id is required`);
  if (typeof row.text !== 'string') throw new Error(`Invalid queue row at line ${lineNumber}: text must be a string`);
  if (typeof row.received_at !== 'string' || !row.received_at.trim()) throw new Error(`Invalid queue row at line ${lineNumber}: received_at must be a non-empty string`);
  if (row.source !== 'hermes-gateway') throw new Error(`Invalid queue row at line ${lineNumber}: source must be hermes-gateway`);
  if (row.sanitized !== true) throw new Error(`Invalid queue row at line ${lineNumber}: sanitized must be true`);
}

function queueRowToTelegramUpdate(row) {
  return {
    update_id: row.update_id,
    message: {
      message_id: row.message_id,
      chat: { id: row.chat_id },
      text: row.text,
      date: Math.floor(Date.parse(row.received_at) / 1000) || undefined,
    },
  };
}

function routedPreviewRow({ row, lineNumber, route }) {
  return {
    ok: true,
    preview_only: true,
    queue_source: 'hermes-gateway',
    sanitized: true,
    line_number: lineNumber,
    update_id: row.update_id,
    message_id: row.message_id,
    received_at: row.received_at,
    status: route.status,
    route_type: route.route_type ?? null,
    classification: route.classification ?? route.intent_type ?? null,
    intent_type: route.intent_type ?? null,
    approval_id_or_alias: route.approval_id_or_alias ?? null,
    decision_preview: route.decision_preview ?? null,
    risk_level: route.risk_level ?? null,
    approval_required: route.approval_required ?? null,
    missing_clarifications: route.missing_clarifications ?? [],
    safe_summary_for_telegram: route.safe_summary_for_telegram ?? null,
    reason: route.reason ?? null,
    ignored: route.ignored === true,
    registered_chat_verified: route.registered_chat_verified === true,
    chat_id_redacted: route.chat_id_redacted ?? '[REDACTED]',
    ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  };
}

export async function runTelegramUpdateRouterWorker({ queueJsonl, outputJsonl, dryRun = false, registeredChatId } = {}) {
  const queuePath = validateExplicitPath(queueJsonl, '--queue-jsonl');
  const outputPath = outputJsonl ? validateExplicitPath(outputJsonl, '--output-jsonl') : null;
  const content = await readFile(queuePath, 'utf8');
  const parsedRows = parseQueueJsonl(content);
  const seen = new Set();
  const routes = [];
  const skipped = [];

  for (const { line_number: lineNumber, row } of parsedRows) {
    validateQueueRow(row, lineNumber);
    const dedupeKey = `${row.update_id}:${row.message_id}`;
    if (seen.has(dedupeKey)) {
      skipped.push({ line_number: lineNumber, update_id: row.update_id, message_id: row.message_id, reason: 'DUPLICATE_UPDATE_MESSAGE' });
      continue;
    }
    seen.add(dedupeKey);
    const effectiveRegisteredChatId = registeredChatId == null ? String(row.chat_id) : String(registeredChatId);
    const route = routeTelegramUpdatePreview(queueRowToTelegramUpdate(row), { registeredChatId: effectiveRegisteredChatId });
    routes.push(routedPreviewRow({ row, lineNumber, route }));
  }

  const wrote = [];
  if (outputPath && !dryRun) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${routes.map((route) => JSON.stringify(route)).join('\n')}${routes.length ? '\n' : ''}`, { encoding: 'utf8', mode: 0o600 });
    wrote.push(outputPath);
  }

  return {
    ok: true,
    preview_only: true,
    worker: 'telegram_update_router_worker',
    input: 'queue-jsonl',
    queue_jsonl: queuePath,
    dry_run: dryRun,
    output_jsonl: outputPath,
    output_jsonl_written: wrote.length > 0,
    wrote,
    row_count: parsedRows.length,
    routed_count: routes.filter((route) => route.status === 'routed').length,
    ignored_count: routes.filter((route) => route.status === 'ignored').length,
    skipped_duplicate_count: skipped.length,
    failed_count: 0,
    routes,
    skipped,
    ...TELEGRAM_UPDATE_ROUTER_WORKER_SIDE_EFFECTS,
    outputJsonlWrites: wrote.length > 0,
  };
}

export async function runTelegramUpdateRouterWorkerCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: telegram-update-router-worker --queue-jsonl <path> [--dry-run] [--output-jsonl <path>] [--registered-chat-id <id>] --json\n');
    return null;
  }
  requireJson(args);
  const result = await runTelegramUpdateRouterWorker({
    queueJsonl: args.queueJsonl,
    outputJsonl: args.outputJsonl,
    dryRun: args.dryRun,
    registeredChatId: args.registeredChatId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramUpdateRouterWorkerCli().catch((error) => {
    process.stderr.write(`${redactTelegramRouterText(error?.message || error, 500)}\n`);
    process.exitCode = 1;
  });
}
