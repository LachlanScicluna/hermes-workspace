#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin as input } from 'node:process';
import { pathToFileURL } from 'node:url';
import { TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS } from './telegram-update-router-preview.mjs';

export const TELEGRAM_GATEWAY_QUEUE_CONTRACT_SIDE_EFFECTS = Object.freeze({
  ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  gatewayQueueWrites: false,
  approvalDecisionWrites: false,
  offsetWrites: false,
  routerWorkerExecuted: false,
  liveGatewayChanges: false,
});

const SECRET_PATTERNS = Object.freeze([
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /gh[pousr]_[A-Za-z0-9_]{20,}/gi,
  /github\.\.\.[A-Za-z0-9_-]+/gi,
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,
  /sk-[A-Za-z0-9_-]{16,}/gi,
  /xox[baprs]-[A-Za-z0-9-]{16,}/gi,
  /(["']?(?:token|secret|password|api[_-]?key|client[_-]?secret|chat[_-]?id)["']?\s*[:=]\s*)["']?[^\s,'"}]+["']?/gi,
  /\bchat[_-]?id\s+[-]?\d{5,}\b/gi,
]);

export function redactTelegramGatewayQueueText(value, cap = 2000) {
  let text = String(value ?? '').replace(/\u0000/g, '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return text.slice(0, cap);
}

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--update-json') args.updateJson = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return args;
}

function requireJson(args) {
  if (!args.json) throw new Error('telegram-gateway-queue-contract-preview is intentionally JSON-only. Pass --json.');
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

function extractMessage(update) {
  return update?.message ?? null;
}

function extractQueueFields(update) {
  const message = extractMessage(update);
  return {
    updateId: update?.update_id,
    messageId: message?.message_id,
    chatId: message?.chat?.id,
    text: message?.text,
    date: message?.date,
  };
}

function redactedErrorMessage(error) {
  return redactTelegramGatewayQueueText(error?.message || error || 'unknown error', 500);
}

function receivedAtFromMessageDate(dateValue) {
  if (Number.isSafeInteger(dateValue) && dateValue > 0) return new Date(dateValue * 1000).toISOString();
  return new Date(0).toISOString();
}

function assertRequiredTextMessageFields(fields) {
  if (!Number.isSafeInteger(fields.updateId)) throw new Error('Invalid Telegram update fixture: update_id must be a safe integer');
  if (!Number.isSafeInteger(fields.messageId)) throw new Error('Invalid Telegram update fixture: message.message_id must be a safe integer');
  if (fields.chatId === null || fields.chatId === undefined || String(fields.chatId).trim() === '') {
    throw new Error('Invalid Telegram update fixture: message.chat.id is required');
  }
}

export function previewTelegramGatewayQueueContract(update) {
  const fields = extractQueueFields(update);
  if (fields.text === undefined || fields.text === null) {
    return {
      ok: true,
      preview_only: true,
      status: 'ignored',
      reason: 'NON_TEXT_MESSAGE',
      row: null,
      ignored: true,
      queue_writer_path_required: true,
      default_live_queue_write_path: null,
      ...TELEGRAM_GATEWAY_QUEUE_CONTRACT_SIDE_EFFECTS,
    };
  }

  assertRequiredTextMessageFields(fields);
  if (typeof fields.text !== 'string') throw new Error('Invalid Telegram update fixture: message.text must be a string');

  const row = {
    update_id: fields.updateId,
    message_id: fields.messageId,
    chat_id: '[REDACTED]',
    text: redactTelegramGatewayQueueText(fields.text),
    received_at: receivedAtFromMessageDate(fields.date),
    source: 'hermes-gateway',
    sanitized: true,
  };

  return {
    ok: true,
    preview_only: true,
    status: 'routed',
    reason: null,
    row,
    ignored: false,
    queue_writer_path_required: true,
    default_live_queue_write_path: null,
    ...TELEGRAM_GATEWAY_QUEUE_CONTRACT_SIDE_EFFECTS,
  };
}

export async function runTelegramGatewayQueueContractPreviewCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: telegram-gateway-queue-contract-preview [--update-json <path>] --json\n');
    return null;
  }
  requireJson(args);
  const update = await loadUpdateJson(args);
  const result = previewTelegramGatewayQueueContract(update);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramGatewayQueueContractPreviewCli().catch((error) => {
    process.stderr.write(`${redactedErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
