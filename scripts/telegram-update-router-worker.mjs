#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
  task_creation: false,
  approval_request_creation: false,
  execution_performed: false,
});

const REQUIRED_ROW_FIELDS = ['update_id', 'message_id', 'chat_id', 'text', 'source', 'sanitized'];
const DEFAULT_DEDUPE_WINDOW_MINUTES = 15;
export const MAX_TELEGRAM_ID_DECIMAL_DIGITS = 64;
const PROTECTED_COMMAND_PATTERN = /^\s*\/(?:approve|reject|deny)(?:@[A-Za-z][A-Za-z0-9_]{0,31})?(?=$|\s)/i;
const EXPLICIT_NONCE_PATTERN = /(?:^|[^A-Za-z0-9_-])nonce[:=]([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?=$|\s|[.,!?;:)\]}](?=$|\s))/i;
const HERMES_TIMESTAMP_NONCE_PATTERN = /(?:^|[\s(\[{'"])(TG[A-Z0-9]{1,12}-\d{8}T\d{6}Z)(?=$|\s|[.,;:!?)\]}'"](?=$|\s))/;
const STRICT_UTC_RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function parseArgs(argv) {
  const args = { dryRun: false, json: false, dedupePreview: false };
  const optionValue = (flagName, index) => {
    const value = argv[index + 1];
    const signedChatId = flagName === '--registered-chat-id' && /^-[0-9]+$/.test(value ?? '');
    if (!value || (value.startsWith('-') && !signedChatId)) throw new Error(`${flagName} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--queue-jsonl') args.queueJsonl = optionValue(arg, index++);
    else if (arg === '--output-jsonl') args.outputJsonl = optionValue(arg, index++);
    else if (arg === '--registered-chat-id') args.registeredChatId = optionValue(arg, index++);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--dedupe-preview') args.dedupePreview = true;
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

export function normalizeTelegramId(value, fieldName, lineNumber) {
  const shapeError = () => new Error(`Invalid queue row at line ${lineNumber}: ${fieldName} must be a non-negative integer or base-10 numeric string`);
  const lengthError = () => new Error(`Invalid queue row at line ${lineNumber}: ${fieldName} must be at most ${MAX_TELEGRAM_ID_DECIMAL_DIGITS} decimal digits`);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw shapeError();
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TELEGRAM_ID_DECIMAL_DIGITS) throw lengthError();
    if (/^[0-9]+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  }
  throw shapeError();
}

function normalizeTelegramChatId(value, lineNumber) {
  const shapeError = () => new Error(`Invalid queue row at line ${lineNumber}: chat_id must be a signed base-10 integer`);
  const lengthError = () => new Error(`Invalid queue row at line ${lineNumber}: chat_id must be at most ${MAX_TELEGRAM_ID_DECIMAL_DIGITS} decimal digits`);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw shapeError();
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'string') throw shapeError();
  const digits = value.startsWith('-') ? value.slice(1) : value;
  if (digits.length > MAX_TELEGRAM_ID_DECIMAL_DIGITS) throw lengthError();
  if (!/^[0-9]+$/.test(digits)) throw shapeError();
  const canonicalDigits = digits.replace(/^0+(?=\d)/, '');
  return value.startsWith('-') && canonicalDigits !== '0' ? `-${canonicalDigits}` : canonicalDigits;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function strictReceivedAt(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(STRICT_UTC_RFC3339_PATTERN);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const fractionNanoseconds = fraction.padEnd(9, '0');
  const epochSeconds = Math.floor(date.getTime() / 1000);
  return {
    canonical: value,
    sortKey: `${yearText}${monthText}${dayText}${hourText}${minuteText}${secondText}${fractionNanoseconds}`,
    epochSeconds,
    epochNanoseconds: (BigInt(epochSeconds) * 1_000_000_000n) + BigInt(fractionNanoseconds || '0'),
  };
}

function validateQueueRow(row, lineNumber) {
  const missing = REQUIRED_ROW_FIELDS.filter((field) => !(field in Object(row)));
  if (missing.length > 0) throw new Error(`Invalid queue row at line ${lineNumber}: missing ${missing.join(', ')}`);
  const canonicalUpdateId = normalizeTelegramId(row.update_id, 'update_id', lineNumber);
  const canonicalMessageId = normalizeTelegramId(row.message_id, 'message_id', lineNumber);
  const canonicalChatId = normalizeTelegramChatId(row.chat_id, lineNumber);
  if (typeof row.text !== 'string') throw new Error(`Invalid queue row at line ${lineNumber}: text must be a string`);
  if (row.source !== 'hermes-gateway') throw new Error(`Invalid queue row at line ${lineNumber}: source must be hermes-gateway`);
  if (row.sanitized !== true) throw new Error(`Invalid queue row at line ${lineNumber}: sanitized must be true`);
  return { canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt: strictReceivedAt(row.received_at) };
}

function queueRowToTelegramUpdate(row, canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt) {
  return {
    update_id: canonicalUpdateId,
    message: {
      message_id: canonicalMessageId,
      chat: { id: canonicalChatId },
      text: row.text,
      date: receivedAt?.epochSeconds,
    },
  };
}

function routedPreviewRow({ row, lineNumber, canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt, nonce, route }) {
  return {
    ok: true,
    preview_only: true,
    queue_source: 'hermes-gateway',
    sanitized: true,
    line_number: lineNumber,
    update_id: canonicalUpdateId,
    message_id: canonicalMessageId,
    received_at_valid: receivedAt !== null,
    received_at_canonical: receivedAt?.canonical ?? null,
    text_len: row.text.length,
    text_sha256: hashedDedupeKey(row.text),
    nonce_present: nonce !== null,
    nonce_sha256: nonce === null ? null : hashedDedupeKey(nonce),
    chat_hash: hashedDedupeKey(canonicalChatId),
    status: route.status,
    route_type: route.route_type ?? null,
    classification: route.classification ?? route.intent_type ?? null,
    intent_type: route.intent_type ?? null,
    approval_id_or_alias: route.approval_id_or_alias ?? null,
    decision_preview: route.decision_preview ?? null,
    risk_level: route.risk_level ?? null,
    approval_required: route.approval_required ?? null,
    missing_clarifications: route.missing_clarifications ?? [],
    reason: route.reason ?? null,
    ignored: route.ignored === true,
    registered_chat_verified: route.registered_chat_verified === true,
    chat_id_redacted: route.chat_id_redacted ?? '[REDACTED]',
    ...TELEGRAM_UPDATE_ROUTER_SIDE_EFFECTS,
  };
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashedDedupeKey(material) {
  return `sha256:${sha256(material)}`;
}

function normalizedDedupeText(text) {
  return String(text).replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function explicitNonce(text) {
  const value = String(text);
  const explicit = value.match(EXPLICIT_NONCE_PATTERN)?.[1];
  if (explicit) return explicit;
  return value.match(HERMES_TIMESTAMP_NONCE_PATTERN)?.[1] ?? null;
}

function compareEntries(left, right) {
  const leftTime = left.receivedAt ?? strictReceivedAt(left.row.received_at);
  const rightTime = right.receivedAt ?? strictReceivedAt(right.row.received_at);
  if (leftTime !== null && rightTime !== null && leftTime.sortKey !== rightTime.sortKey) return leftTime.sortKey < rightTime.sortKey ? -1 : 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return left.line_number - right.line_number;
}

function canonicalEntry(entries) {
  return [...entries].sort(compareEntries)[0];
}

function isRouteDownstreamEligible(route, suppressed = false) {
  return route.status === 'routed' && route.received_at_valid === true && !suppressed;
}

function isEntryDownstreamEligible(entry) {
  return isRouteDownstreamEligible(entry.route) && strictReceivedAt(entry.row.received_at) !== null;
}

function dedupePreviewRow(strategy, keyMaterial, entries) {
  const canonical = canonicalEntry(entries);
  const duplicateIndexes = entries
    .filter((entry) => entry !== canonical)
    .map((entry) => entry.line_number)
    .sort((left, right) => left - right);
  const nonce = strategy === 'protected_command_bypass' ? null : explicitNonce(canonical.row.text);
  const canonicalChatId = normalizeTelegramChatId(canonical.row.chat_id, canonical.line_number);
  const chatHash = hashedDedupeKey(canonicalChatId);
  return {
    dedupe_enabled: strategy !== 'disabled',
    strategy,
    dedupe_key: hashedDedupeKey(keyMaterial),
    canonical_row_index: canonical.line_number,
    canonical_update_id: canonical.canonicalUpdateId,
    canonical_message_id: canonical.canonicalMessageId,
    duplicate_row_indexes: duplicateIndexes,
    canonical_count: 1,
    suppressed_duplicate_count: duplicateIndexes.length,
    downstream_eligible: isEntryDownstreamEligible(canonical),
    text_len: canonical.row.text.length,
    text_sha256: hashedDedupeKey(canonical.row.text),
    nonce_present: nonce !== null,
    nonce_sha256: nonce === null ? null : hashedDedupeKey(nonce),
    chat_hash: chatHash,
    route_type: canonical.route.route_type ?? null,
    classification: canonical.route.classification ?? null,
    approval_required: canonical.route.approval_required ?? null,
    task_creation: false,
    approval_request_creation: false,
    output_jsonl_writes: false,
    execution_performed: false,
  };
}

function fallbackBuckets(entries, windowMs) {
  const sorted = [...entries].sort(compareEntries);
  const windowNanoseconds = BigInt(Math.round(windowMs * 1_000_000));
  const buckets = [];
  for (const entry of sorted) {
    const receivedAt = entry.receivedAt ?? strictReceivedAt(entry.row.received_at);
    if (receivedAt === null) {
      buckets.push({ anchorSortKey: null, entries: [entry] });
      continue;
    }
    const current = buckets.at(-1);
    const anchorEntry = current?.entries[0];
    const anchorReceivedAt = anchorEntry ? (anchorEntry.receivedAt ?? strictReceivedAt(anchorEntry.row.received_at)) : null;
    if (!current || current.anchorSortKey === null || anchorReceivedAt === null || receivedAt.epochNanoseconds - anchorReceivedAt.epochNanoseconds > windowNanoseconds) {
      buckets.push({ anchorSortKey: receivedAt.sortKey, entries: [entry] });
    } else {
      current.entries.push(entry);
    }
  }
  return buckets.map((bucket) => bucket.entries);
}

export function buildTelegramDedupePreview(entries, { enabled = false, windowMinutes = DEFAULT_DEDUPE_WINDOW_MINUTES } = {}) {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('dedupe window must be a positive number of minutes');
  const preparedEntries = entries.map((entry) => {
    const canonicalUpdateId = normalizeTelegramId(entry.row.update_id, 'update_id', entry.line_number);
    const canonicalMessageId = normalizeTelegramId(entry.row.message_id, 'message_id', entry.line_number);
    const canonicalChatId = normalizeTelegramChatId(entry.row.chat_id, entry.line_number);
    return {
      ...entry,
      canonicalUpdateId,
      canonicalMessageId,
      canonicalChatId,
      chatHash: hashedDedupeKey(canonicalChatId),
      receivedAt: strictReceivedAt(entry.row.received_at),
    };
  });
  const previews = [];
  if (!enabled) {
    for (const entry of preparedEntries) {
      previews.push(dedupePreviewRow('disabled', `disabled:${entry.canonicalUpdateId}:${entry.canonicalMessageId}`, [entry]));
    }
  } else {
    const nonceGroups = new Map();
    const fallbackGroups = new Map();
    for (const entry of preparedEntries) {
      const { chatHash } = entry;
      const preparedEntry = entry;
      const protectedCommand = entry.protectedCommand === true || PROTECTED_COMMAND_PATTERN.test(entry.row.text);
      if (protectedCommand) {
        previews.push(dedupePreviewRow('protected_command_bypass', `protected:${chatHash}:${entry.canonicalUpdateId}:${entry.canonicalMessageId}`, [{ ...preparedEntry, nonce: null }]));
        continue;
      }
      const nonce = explicitNonce(entry.row.text);
      if (nonce) {
        const material = `nonce:${chatHash}:${nonce}`;
        const group = nonceGroups.get(material) ?? [];
        group.push({ ...preparedEntry, nonce });
        nonceGroups.set(material, group);
        continue;
      }
      const normalizedText = normalizedDedupeText(entry.row.text);
      const material = `fallback:${chatHash}:${normalizedText}`;
      const group = fallbackGroups.get(material) ?? [];
      group.push({ ...preparedEntry, nonce: null, normalizedText });
      fallbackGroups.set(material, group);
    }
    for (const [material, group] of nonceGroups) previews.push(dedupePreviewRow('explicit_nonce', material, group));
    const windowMs = windowMinutes * 60 * 1000;
    for (const [material, group] of fallbackGroups) {
      for (const bucket of fallbackBuckets(group, windowMs)) {
        const canonical = canonicalEntry(bucket);
        const receivedAt = canonical.receivedAt ?? strictReceivedAt(canonical.row.received_at);
        const discriminator = `${receivedAt?.sortKey ?? 'invalid'}:row:${canonical.line_number}`;
        previews.push(dedupePreviewRow('fallback_fingerprint', `${material}:anchor:${discriminator}`, bucket));
      }
    }
  }
  previews.sort((left, right) => left.canonical_row_index - right.canonical_row_index);
  return {
    dedupe_enabled: enabled,
    strategy: enabled ? 'nonce_first' : 'disabled',
    dedupe_window_minutes: windowMinutes,
    dedupe_previews: previews,
    canonical_count: previews.length,
    suppressed_duplicate_count: previews.reduce((total, preview) => total + preview.suppressed_duplicate_count, 0),
  };
}

function annotateRoutesWithDedupe(routes, previews, { safeMetadataOnly = false } = {}) {
  const byLine = new Map();
  for (const preview of previews) {
    byLine.set(preview.canonical_row_index, { preview, suppressed: false });
    for (const line of preview.duplicate_row_indexes) byLine.set(line, { preview, suppressed: true });
  }
  return routes.map((route) => {
    const match = byLine.get(route.line_number);
    const suppressed = match?.suppressed === true;
    const annotated = {
      ...route,
      dedupe_strategy: match?.preview.strategy ?? 'disabled',
      dedupe_key: match?.preview.dedupe_key ?? null,
      canonical_row_index: match?.preview.canonical_row_index ?? route.line_number,
      suppressed_duplicate: suppressed,
      downstream_eligible: isRouteDownstreamEligible(route, suppressed),
      task_creation: false,
      approval_request_creation: false,
      execution_performed: false,
    };
    if (safeMetadataOnly) delete annotated.approval_id_or_alias;
    return annotated;
  });
}

export async function runTelegramUpdateRouterWorker({
  queueJsonl,
  outputJsonl,
  dryRun = false,
  registeredChatId,
  dedupePreview = false,
  dedupeWindowMinutes = DEFAULT_DEDUPE_WINDOW_MINUTES,
} = {}) {
  const queuePath = validateExplicitPath(queueJsonl, '--queue-jsonl');
  const outputPath = outputJsonl ? validateExplicitPath(outputJsonl, '--output-jsonl') : null;
  const content = await readFile(queuePath, 'utf8');
  const parsedRows = parseQueueJsonl(content);
  const seen = new Set();
  const routeEntries = [];
  const skipped = [];

  for (const { line_number: lineNumber, row } of parsedRows) {
    const { canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt } = validateQueueRow(row, lineNumber);
    const protectedCommand = PROTECTED_COMMAND_PATTERN.test(row.text);
    const technicalDedupeKey = `${canonicalUpdateId}:${canonicalMessageId}`;
    if (!protectedCommand) {
      if (seen.has(technicalDedupeKey)) {
        skipped.push({ line_number: lineNumber, update_id: canonicalUpdateId, message_id: canonicalMessageId, reason: 'DUPLICATE_UPDATE_MESSAGE' });
        continue;
      }
      seen.add(technicalDedupeKey);
    }
    const nonce = protectedCommand ? null : explicitNonce(row.text);
    const chatHash = hashedDedupeKey(canonicalChatId);
    const normalizedText = normalizedDedupeText(row.text);
    const effectiveRegisteredChatId = registeredChatId == null ? canonicalChatId : normalizeTelegramChatId(registeredChatId, lineNumber);
    const route = routeTelegramUpdatePreview(queueRowToTelegramUpdate(row, canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt), { registeredChatId: effectiveRegisteredChatId });
    routeEntries.push({
      line_number: lineNumber,
      row,
      canonicalUpdateId,
      canonicalMessageId,
      canonicalChatId,
      receivedAt,
      protectedCommand,
      nonce,
      chatHash,
      normalizedText,
      route: routedPreviewRow({ row, lineNumber, canonicalUpdateId, canonicalMessageId, canonicalChatId, receivedAt, nonce, route }),
    });
  }

  const dedupe = buildTelegramDedupePreview(routeEntries, { enabled: dedupePreview, windowMinutes: dedupeWindowMinutes });
  const routes = annotateRoutesWithDedupe(routeEntries.map((entry) => entry.route), dedupe.dedupe_previews, { safeMetadataOnly: dedupePreview });
  const wrote = [];
  if (outputPath && !dryRun && !dedupePreview) {
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
    ...dedupe,
    downstream_eligible_count: routes.filter((route) => route.downstream_eligible).length,
    task_creation: false,
    approval_request_creation: false,
    execution_performed: false,
    ...TELEGRAM_UPDATE_ROUTER_WORKER_SIDE_EFFECTS,
    outputJsonlWrites: wrote.length > 0,
  };
}

export async function runTelegramUpdateRouterWorkerCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: telegram-update-router-worker --queue-jsonl <path> [--dry-run] [--dedupe-preview] [--output-jsonl <path>] [--registered-chat-id <id>] --json\n');
    return null;
  }
  requireJson(args);
  const result = await runTelegramUpdateRouterWorker({
    queueJsonl: args.queueJsonl,
    outputJsonl: args.outputJsonl,
    dryRun: args.dryRun,
    registeredChatId: args.registeredChatId,
    dedupePreview: args.dedupePreview,
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
