import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTelegramDedupePreview,
  normalizeTelegramId,
  runTelegramUpdateRouterWorker,
  runTelegramUpdateRouterWorkerCli,
} from './telegram-update-router-worker.mjs';

const CHAT_A = '123456789';
const CHAT_B = '987654321';

function queueRow(text, overrides = {}) {
  return {
    update_id: overrides.update_id ?? 1001,
    message_id: overrides.message_id ?? 2002,
    chat_id: overrides.chat_id ?? CHAT_A,
    text,
    received_at: overrides.received_at ?? '2026-07-10T09:00:00.000Z',
    source: 'hermes-gateway',
    sanitized: true,
    ...overrides,
  };
}

async function withQueue(rows, fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tg-48-router-dedupe-'));
  const queuePath = path.join(tempDir, 'queue.jsonl');
  try {
    await writeFile(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    return await fn({ tempDir, queuePath });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expectPreviewOnly(result) {
  expect(result.task_creation).toBe(false);
  expect(result.approval_request_creation).toBe(false);
  expect(result.execution_performed).toBe(false);
  expect(result.outputJsonlWrites).toBe(false);
  expect(result.telegramPolled).toBe(false);
  expect(result.telegramMessagesSent).toBe(false);
  expect(result.approvalDecisionWrites).toBe(false);
}

describe('Telegram queue ID normalization', () => {
  it('accepts safe non-negative integers and returns canonical decimal strings', () => {
    expect(normalizeTelegramId(0, 'update_id', 1)).toBe('0');
    expect(normalizeTelegramId(7582, 'message_id', 1)).toBe('7582');
    expect(normalizeTelegramId(Number.MAX_SAFE_INTEGER, 'update_id', 1)).toBe('9007199254740991');
  });

  it('accepts numeric strings, canonicalizes leading zeroes, and preserves large values without Number conversion', () => {
    expect(normalizeTelegramId('0', 'message_id', 1)).toBe('0');
    expect(normalizeTelegramId('0000', 'message_id', 1)).toBe('0');
    expect(normalizeTelegramId('7582', 'message_id', 1)).toBe('7582');
    expect(normalizeTelegramId('693413821', 'update_id', 1)).toBe('693413821');
    expect(normalizeTelegramId('0007582', 'message_id', 1)).toBe('7582');
    expect(normalizeTelegramId('9007199254740993', 'message_id', 1)).toBe('9007199254740993');
  });

  it('accepts exactly 64 digits and rejects longer decimal strings without echoing them', () => {
    const sixtyFourDigits = '9'.repeat(64);
    const sixtyFiveDigits = '9'.repeat(65);
    const huge = '7'.repeat(100_000);
    expect(normalizeTelegramId(sixtyFourDigits, 'update_id', 1)).toBe(sixtyFourDigits);
    expect(() => normalizeTelegramId(sixtyFiveDigits, 'update_id', 1)).toThrow('update_id must be at most 64 decimal digits');
    try {
      normalizeTelegramId(huge, 'message_id', 7);
      throw new Error('expected huge ID rejection');
    } catch (error) {
      expect(String(error.message)).toContain('message_id must be at most 64 decimal digits');
      expect(String(error.message)).not.toContain(huge);
    }
  });

  it.each(['', '-1', '1.5', '1e3', 'id=7582', ' 7582', '7582 '])('rejects malformed numeric string %j', (value) => {
    expect(() => normalizeTelegramId(value, 'message_id', 1)).toThrow('message_id must be a non-negative integer or base-10 numeric string');
  });

  it.each([true, false, null, undefined, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid non-string ID %j', (value) => {
    expect(() => normalizeTelegramId(value, 'update_id', 1)).toThrow('update_id must be a non-negative integer or base-10 numeric string');
  });

  it('routes mixed integer and numeric-string rows while preserving canonical ID precision and input rows', async () => {
    const rows = [
      queueRow('build integer fixture', { update_id: 11, message_id: 12 }),
      queueRow('build string fixture', { update_id: '693413821', message_id: '9007199254740993' }),
    ];
    const originalRows = structuredClone(rows);
    await withQueue(rows, async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A });
      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].update_id).toBe('11');
      expect(result.routes[0].message_id).toBe('12');
      expect(result.routes[1].update_id).toBe('693413821');
      expect(result.routes[1].message_id).toBe('9007199254740993');
      expect(result.routes.every((route) => route.classification === 'code_change')).toBe(true);
      expect(rows).toEqual(originalRows);
    });
  });

  it('rejects non-scalar or overlong chat identities before dedupe grouping', async () => {
    await withQueue([queueRow('build object chat fixture', { chat_id: { distinct: 'chat-a' } })], async ({ queuePath }) => {
      await expect(runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true })).rejects.toThrow('chat_id must be a signed base-10 integer');
    });
    await withQueue([queueRow('build overlong chat fixture', { chat_id: '8'.repeat(65) })], async ({ queuePath }) => {
      await expect(runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true })).rejects.toThrow('chat_id must be at most 64 decimal digits');
    });
  });

  it('rejects unsafe chat identities through the exported dedupe helper too', () => {
    const entry = (chatId, lineNumber) => ({
      line_number: lineNumber,
      canonicalUpdateId: String(lineNumber),
      canonicalMessageId: String(lineNumber + 10),
      row: queueRow('build helper fixture', { chat_id: chatId }),
      route: { status: 'routed', classification: 'code_change' },
    });
    expect(() => buildTelegramDedupePreview([
      entry({ distinct: 'chat-a' }, 1),
      entry({ distinct: 'chat-b' }, 2),
    ], { enabled: true })).toThrow('chat_id must be a signed base-10 integer');
  });
});

describe('disabled nonce-first Telegram dedupe preview', () => {
  it('is disabled by default and does not suppress distinct Telegram sends sharing a nonce', async () => {
    const rows = [
      queueRow('TGQ: nonce:abc build module', { update_id: 1, message_id: 11 }),
      queueRow('TGQ: nonce:abc build module', { update_id: 2, message_id: 12 }),
    ];
    await withQueue(rows, async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A });
      expect(result.dedupe_enabled).toBe(false);
      expect(result.routes).toHaveLength(2);
      expect(result.suppressed_duplicate_count).toBe(0);
      expect(result.routes.every((route) => route.downstream_eligible)).toBe(true);
    });
  });

  it('collapses three distinct Telegram sends sharing the TG47A nonce and selects earliest received row', async () => {
    const text = 'TGQ: TG47A queue-first canary TG47A-20260709T142255Z build me a flights tracker module in LifeOS';
    const rows = [
      queueRow(text, { update_id: '693413823', message_id: '7584', received_at: '2026-07-10T09:35:19.154Z' }),
      queueRow(text, { update_id: '693413821', message_id: '7582', received_at: '2026-07-10T09:26:18.021Z' }),
      queueRow(text, { update_id: '693413822', message_id: '7583', received_at: '2026-07-10T09:27:40.580Z' }),
    ];
    await withQueue(rows, async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
      expect(result.dedupe_enabled).toBe(true);
      expect(result.routes).toHaveLength(3);
      expect(result.routes.every((route) => route.route_type === 'natural_language_task_intake')).toBe(true);
      expect(result.routes.every((route) => route.classification === 'code_change')).toBe(true);
      expect(result.routes.every((route) => route.approval_required === true)).toBe(true);
      expect(result.canonical_count).toBe(1);
      expect(result.suppressed_duplicate_count).toBe(2);
      expect(result.dedupe_previews).toHaveLength(1);
      expect(result.dedupe_previews[0]).toMatchObject({
        strategy: 'explicit_nonce',
        canonical_row_index: 2,
        canonical_update_id: '693413821',
        canonical_message_id: '7582',
        duplicate_row_indexes: [1, 3],
        canonical_count: 1,
        suppressed_duplicate_count: 2,
        downstream_eligible: true,
        task_creation: false,
        approval_request_creation: false,
        output_jsonl_writes: false,
        execution_performed: false,
      });
      expect(result.dedupe_previews[0].dedupe_key).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.routes.filter((route) => route.downstream_eligible)).toHaveLength(1);
      expectPreviewOnly(result);
    });
  });

  it('keeps different explicit nonces separate', async () => {
    await withQueue(
      [
        queueRow('TGQ: nonce=alpha build module', { update_id: 1, message_id: 11 }),
        queueRow('TGQ: nonce=beta build module', { update_id: 2, message_id: 12 }),
        queueRow('TGQ: NONCE=Alpha build module', { update_id: 3, message_id: 13 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.canonical_count).toBe(3);
        expect(result.suppressed_duplicate_count).toBe(0);
        expect(result.routes.every((route) => route.nonce_present)).toBe(true);
      },
    );
  });

  it('rejects an ambiguous slash-delimited marker instead of extracting a partial nonce', async () => {
    await withQueue(
      [
        queueRow('nonce:abc/def build module', { update_id: 1, message_id: 11 }),
        queueRow('nonce:abc/def build module differently', { update_id: 2, message_id: 12 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.every((route) => route.nonce_present === false)).toBe(true);
        expect(result.suppressed_duplicate_count).toBe(0);
      },
    );
  });

  it.each(['nonce:abc,def', 'nonce:abc.def', 'nonce:abc!def'])('rejects non-terminal marker punctuation in %s', async (marker) => {
    await withQueue(
      [
        queueRow(`${marker} build one module`, { update_id: 1, message_id: 11 }),
        queueRow(`${marker} build another module`, { update_id: 2, message_id: 12 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.every((route) => route.nonce_present === false)).toBe(true);
        expect(result.suppressed_duplicate_count).toBe(0);
      },
    );
  });

  it('dedupes normalized whitespace for the same chat inside the 15-minute window', async () => {
    await withQueue(
      [
        queueRow('build\r\n  a   flights tracker', { update_id: 1, message_id: 11, received_at: '2026-07-10T09:00:00Z' }),
        queueRow('  build a flights tracker  ', { update_id: 2, message_id: 12, received_at: '2026-07-10T09:14:59Z' }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.dedupe_previews).toHaveLength(1);
        expect(result.dedupe_previews[0].strategy).toBe('fallback_fingerprint');
        expect(result.suppressed_duplicate_count).toBe(1);
      },
    );
  });

  it('keeps the same fallback request outside 15 minutes separate', async () => {
    await withQueue(
      [
        queueRow('build a flights tracker', { update_id: 1, message_id: 11, received_at: '2026-07-10T09:00:00Z' }),
        queueRow('build a flights tracker', { update_id: 2, message_id: 12, received_at: '2026-07-10T09:15:01Z' }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.canonical_count).toBe(2);
        expect(result.suppressed_duplicate_count).toBe(0);
      },
    );
  });

  it('never dedupes the same fallback text across different chats', async () => {
    await withQueue(
      [
        queueRow('build a flights tracker', { update_id: 1, message_id: 11, chat_id: CHAT_A }),
        queueRow('build a flights tracker', { update_id: 2, message_id: 12, chat_id: CHAT_B }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.canonical_count).toBe(2);
        expect(result.suppressed_duplicate_count).toBe(0);
        expect(JSON.stringify(result)).not.toContain(CHAT_A);
        expect(JSON.stringify(result)).not.toContain(CHAT_B);
      },
    );
  });

  it('never dedupes the same explicit nonce across different chats', async () => {
    await withQueue(
      [
        queueRow('TGQ: nonce=shared build a flights tracker', { update_id: 1, message_id: 11, chat_id: CHAT_A }),
        queueRow('TGQ: nonce=shared build a flights tracker', { update_id: 2, message_id: 12, chat_id: CHAT_B }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.canonical_count).toBe(2);
        expect(result.suppressed_duplicate_count).toBe(0);
        expect(result.dedupe_previews.every((preview) => preview.strategy === 'explicit_nonce')).toBe(true);
        expect(JSON.stringify(result)).not.toContain(CHAT_A);
        expect(JSON.stringify(result)).not.toContain(CHAT_B);
      },
    );
  });

  it('keeps materially different fallback text separate', async () => {
    await withQueue(
      [
        queueRow('build a flights tracker', { update_id: 1, message_id: 11 }),
        queueRow('build an accommodation tracker', { update_id: 2, message_id: 12 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.canonical_count).toBe(2);
        expect(result.suppressed_duplicate_count).toBe(0);
      },
    );
  });

  it.each([
    '/approve edit1',
    '/APPROVE@HermesBot edit1',
    '/ReJeCt@HermesBot edit1',
    '/deny edit1',
    '/DeNy@X\nedit1',
    '  /approve\nedit1',
  ])('never dedupes protected control command %s', async (text) => {
    await withQueue(
      [queueRow(text, { update_id: 1, message_id: 11 }), queueRow(text, { update_id: 2, message_id: 12 })],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.canonical_count).toBe(2);
        expect(result.suppressed_duplicate_count).toBe(0);
        expect(result.dedupe_previews.every((preview) => preview.strategy === 'protected_command_bypass')).toBe(true);
        expect(result.routes.every((route) => route.downstream_eligible === true)).toBe(true);
        expect(result.routes.every((route) => route.suppressed_duplicate === false)).toBe(true);
      },
    );
  });

  it('re-derives helper nonce, chat, text, ID, and timestamp metadata from validated rows', () => {
    const helperEntry = (lineNumber, text, overrides = {}) => ({
      line_number: lineNumber,
      canonicalUpdateId: 'spoofed-update',
      canonicalMessageId: 'spoofed-message',
      chatHash: 'sha256:spoofed-chat',
      nonce: 'spoofed-nonce',
      normalizedText: 'spoofed-text',
      receivedAt: { sortKey: '00000000000000000000000', epochNanoseconds: 0n },
      row: queueRow(text, { update_id: lineNumber, message_id: lineNumber + 10, ...overrides }),
      route: { status: 'routed', received_at_valid: !String(overrides.received_at ?? '').startsWith('bad'), classification: 'code_change' },
    });

    const textDerived = buildTelegramDedupePreview([
      helperEntry(1, 'build alpha module'),
      helperEntry(2, 'build beta module'),
    ], { enabled: true });
    expect(textDerived.dedupe_previews).toHaveLength(2);
    expect(textDerived.suppressed_duplicate_count).toBe(0);
    expect(textDerived.dedupe_previews.every((preview) => preview.nonce_present === false)).toBe(true);
    expect(textDerived.dedupe_previews.map((preview) => preview.canonical_update_id)).toEqual(['1', '2']);

    const chatDerived = buildTelegramDedupePreview([
      helperEntry(3, 'nonce:shared build module', { chat_id: CHAT_A }),
      helperEntry(4, 'nonce:shared build module', { chat_id: CHAT_B }),
    ], { enabled: true });
    expect(chatDerived.dedupe_previews).toHaveLength(2);
    expect(chatDerived.suppressed_duplicate_count).toBe(0);
    expect(new Set(chatDerived.dedupe_previews.map((preview) => preview.chat_hash)).size).toBe(2);

    const timeDerived = buildTelegramDedupePreview([
      helperEntry(5, 'build invalid helper time', { received_at: 'bad-one' }),
      helperEntry(6, 'build invalid helper time', { received_at: 'bad-two' }),
    ], { enabled: true });
    expect(timeDerived.dedupe_previews).toHaveLength(2);
    expect(timeDerived.suppressed_duplicate_count).toBe(0);
    expect(timeDerived.dedupe_previews.every((preview) => preview.downstream_eligible === false)).toBe(true);
  });

  it('does not allow helper metadata to force protected command text into nonce groups', () => {
    const entries = [1, 2].map((lineNumber) => ({
      line_number: lineNumber,
      canonicalUpdateId: String(lineNumber),
      canonicalMessageId: String(lineNumber + 10),
      protectedCommand: false,
      row: queueRow('/APPROVE@HermesBot nonce:abc', { update_id: lineNumber, message_id: lineNumber + 10 }),
      route: { status: 'routed', received_at_valid: true, classification: 'approval_command' },
    }));
    const result = buildTelegramDedupePreview(entries, { enabled: true });
    expect(result.dedupe_previews).toHaveLength(2);
    expect(result.suppressed_duplicate_count).toBe(0);
    expect(result.dedupe_previews.every((preview) => preview.strategy === 'protected_command_bypass')).toBe(true);
  });

  it('does not let technical update/message dedupe suppress protected commands', async () => {
    await withQueue(
      [
        queueRow('/approve edit1', { update_id: 1, message_id: 11 }),
        queueRow('/APPROVE@HermesBot edit1', { update_id: 1, message_id: 11 }),
        queueRow('build a normal request after protected controls', { update_id: 1, message_id: 11 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes).toHaveLength(3);
        expect(result.skipped_duplicate_count).toBe(0);
        expect(result.routes.every((route) => route.downstream_eligible === true)).toBe(true);
        expect(result.routes.every((route) => route.suppressed_duplicate === false)).toBe(true);
        expect(result.dedupe_previews.filter((preview) => preview.strategy === 'protected_command_bypass')).toHaveLength(2);
        expect(result.dedupe_previews.filter((preview) => preview.strategy === 'fallback_fingerprint')).toHaveLength(1);
      },
    );
  });

  it.each(['/approved edit1', '/rejectable edit1', '/denying edit1'])('does not bypass lookalike command %s', async (text) => {
    await withQueue(
      [queueRow(text, { update_id: 1, message_id: 11 }), queueRow(text, { update_id: 2, message_id: 12 })],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.dedupe_previews).toHaveLength(1);
        expect(result.dedupe_previews[0].strategy).toBe('fallback_fingerprint');
        expect(result.suppressed_duplicate_count).toBe(1);
      },
    );
  });

  it('recognizes only bounded explicit markers and exact Hermes TG timestamp tokens', async () => {
    const longNonce = `nonce:${'x'.repeat(65)}`;
    const embedded = 'prefixTG47A-20260709T142255Zsuffix';
    const rows = [
      queueRow('TGQ: nonce:abc. build module', { update_id: 1, message_id: 11 }),
      queueRow('TGQ: nonce:abc build module differently', { update_id: 2, message_id: 12 }),
      queueRow('TGQ: nonce=Build_123, build module', { update_id: 3, message_id: 13 }),
      queueRow('TGQ: nonce=Build_123 build module differently', { update_id: 4, message_id: 14 }),
      queueRow('meeting-20260710T090000Z build flights tracker', { update_id: 5, message_id: 15 }),
      queueRow('meeting-20260710T090000Z build accommodation tracker', { update_id: 6, message_id: 16 }),
      queueRow(`${longNonce} build one module`, { update_id: 7, message_id: 17 }),
      queueRow(`${longNonce} build another module`, { update_id: 8, message_id: 18 }),
      queueRow(`${embedded} build one module`, { update_id: 9, message_id: 19 }),
      queueRow(`${embedded} build another module`, { update_id: 10, message_id: 20 }),
    ];
    await withQueue(rows, async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
      const explicitGroups = result.dedupe_previews.filter((preview) => preview.strategy === 'explicit_nonce');
      expect(explicitGroups).toHaveLength(2);
      expect(explicitGroups.every((preview) => preview.suppressed_duplicate_count === 1)).toBe(true);
      expect(result.routes.slice(4).every((route) => route.nonce_present === false)).toBe(true);
      expect(result.routes[2].nonce_present).toBe(true);
      expect(result.routes[2].nonce_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
  });

  it('accepts a 64-character explicit nonce token and rejects a 65-character token', async () => {
    const bounded = 'A'.repeat(64);
    const overlong = 'B'.repeat(65);
    await withQueue(
      [
        queueRow(`nonce:${bounded}. build one module`, { update_id: 1, message_id: 11 }),
        queueRow(`nonce=${bounded}, build another module`, { update_id: 2, message_id: 12 }),
        queueRow(`nonce:${overlong} build one module`, { update_id: 3, message_id: 13 }),
        queueRow(`nonce:${overlong} build another module`, { update_id: 4, message_id: 14 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.slice(0, 2).every((route) => route.nonce_present === true)).toBe(true);
        expect(result.routes.slice(2).every((route) => route.nonce_present === false)).toBe(true);
        expect(result.dedupe_previews.filter((preview) => preview.strategy === 'explicit_nonce')).toHaveLength(1);
        expect(result.suppressed_duplicate_count).toBe(1);
      },
    );
  });

  it('does not classify meeting, appointment, or arbitrary timestamp-like prose as an explicit nonce', async () => {
    await withQueue(
      [
        queueRow('meeting-20260710T090000Z build module', { update_id: 1, message_id: 11 }),
        queueRow('appointment-20260710T090000Z build module', { update_id: 2, message_id: 12 }),
        queueRow('reminder 20260710T090000Z build module', { update_id: 3, message_id: 13 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.every((route) => route.nonce_present === false)).toBe(true);
        expect(result.dedupe_previews.every((preview) => preview.strategy === 'fallback_fingerprint')).toBe(true);
        expect(result.suppressed_duplicate_count).toBe(0);
      },
    );
  });

  it('recognizes TG47A only within sensible boundaries and isolates chats', async () => {
    const tgText = 'TGQ: TG47A queue-first canary TG47A-20260709T142255Z build flights tracker';
    await withQueue(
      [
        queueRow(tgText, { update_id: 1, message_id: 11, chat_id: CHAT_A }),
        queueRow(tgText, { update_id: 2, message_id: 12, chat_id: CHAT_A }),
        queueRow(tgText, { update_id: 3, message_id: 13, chat_id: CHAT_B }),
        queueRow('meeting-20260710T090000Z build flights tracker', { update_id: 4, message_id: 14 }),
        queueRow('meeting-20260710T090000Z build accommodation tracker', { update_id: 5, message_id: 15 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        const explicitGroups = result.dedupe_previews.filter((preview) => preview.strategy === 'explicit_nonce');
        expect(explicitGroups).toHaveLength(2);
        expect(explicitGroups.map((preview) => preview.suppressed_duplicate_count).sort()).toEqual([0, 1]);
        expect(result.routes[3].nonce_present).toBe(false);
        expect(result.routes[4].nonce_present).toBe(false);
      },
    );
  });

  it.each(['', ' ', '\t', '(', '[', '{', "'", '"'])(
    'recognizes a Hermes TG timestamp token after allowed leading boundary %j',
    async (prefix) => {
      const token = 'TG47A-20260709T142255Z';
      await withQueue([queueRow(`${prefix}${token}`)], async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes[0].nonce_present).toBe(true);
        expect(result.dedupe_previews[0].strategy).toBe('explicit_nonce');
      });
    },
  );

  it.each(['', ' ', '\t', '.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"'])(
    'recognizes a Hermes TG timestamp token before allowed trailing boundary %j',
    async (suffix) => {
      const token = 'TG47A-20260709T142255Z';
      await withQueue([queueRow(`${token}${suffix}`)], async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes[0].nonce_present).toBe(true);
        expect(result.dedupe_previews[0].strategy).toBe('explicit_nonce');
      });
    },
  );

  it('extracts only the TG token when enclosed in parentheses and still dedupes repeated valid tokens', async () => {
    const text = 'TGQ: (TG47A-20260709T142255Z) build flights tracker';
    await withQueue(
      [
        queueRow(text, { update_id: 1, message_id: 11 }),
        queueRow(text, { update_id: 2, message_id: 12 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes.every((route) => route.nonce_present)).toBe(true);
        expect(result.dedupe_previews).toHaveLength(1);
        expect(result.dedupe_previews[0]).toMatchObject({ strategy: 'explicit_nonce', canonical_count: 1, suppressed_duplicate_count: 1 });
      },
    );
  });

  it.each(['/suffix', '\\suffix', '@suffix', '#suffix', '_suffix', '-suffix', 'suffix', '=abc', '+abc', '%abc'])(
    'rejects a Hermes TG timestamp continuation %j without collapsing different requests',
    async (continuation) => {
      const partial = `TG47A-20260709T142255Z${continuation}`;
      await withQueue(
        [
          queueRow(`${partial} build flights tracker`, { update_id: 1, message_id: 11 }),
          queueRow(`${partial} build accommodation tracker`, { update_id: 2, message_id: 12 }),
        ],
        async ({ queuePath }) => {
          const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
          expect(result.routes.every((route) => route.nonce_present === false)).toBe(true);
          expect(result.dedupe_previews.every((preview) => preview.strategy === 'fallback_fingerprint')).toBe(true);
          expect(result.canonical_count).toBe(2);
          expect(result.suppressed_duplicate_count).toBe(0);
        },
      );
    },
  );

  it.each(['prefix', 'x', '_', '-'])(
    'rejects a Hermes TG timestamp embedded after identifier prefix %j',
    async (prefix) => {
      await withQueue([queueRow(`${prefix}TG47A-20260709T142255Z build module`)], async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes[0].nonce_present).toBe(false);
        expect(result.dedupe_previews[0].strategy).toBe('fallback_fingerprint');
      });
    },
  );

  it.each(['tg47a-20260709T142255Z', 'meeting-20260710T090000Z'])(
    'does not treat arbitrary timestamp prose %j as a Hermes nonce',
    async (text) => {
      await withQueue([queueRow(`${text} build module`)], async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes[0].nonce_present).toBe(false);
      });
    },
  );

  it('uses another independently valid explicit nonce when a partial TG token is rejected', async () => {
    const text = 'TG47A-20260709T142255Z/suffix nonce:independent build module';
    await withQueue(
      [queueRow(text, { update_id: 1, message_id: 11 }), queueRow(text, { update_id: 2, message_id: 12 })],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, dedupePreview: true });
        expect(result.routes.every((route) => route.nonce_present)).toBe(true);
        expect(result.dedupe_previews).toHaveLength(1);
        expect(result.dedupe_previews[0]).toMatchObject({ strategy: 'explicit_nonce', suppressed_duplicate_count: 1 });
      },
    );
  });

  it('emits hashes and lengths but no raw request, nonce, or chat identity', async () => {
    const rawNonce = 'SecretBuild_ABC123';
    const rawRequest = `TGQ: nonce:${rawNonce} build the known private flights request sentence`;
    await withQueue([queueRow(rawRequest, { update_id: 1, message_id: 11 })], async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(rawRequest);
      expect(serialized).not.toContain(rawNonce);
      expect(serialized).not.toContain(CHAT_A);
      expect(result.routes[0]).toMatchObject({
        text_len: rawRequest.length,
        nonce_present: true,
        classification: 'code_change',
      });
      expect(result.routes[0].text_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.routes[0].nonce_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.routes[0].chat_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.routes[0]).not.toHaveProperty('safe_summary_for_telegram');
    });
  });

  it('does not leak protected-command aliases that resemble a nonce or chat identity', async () => {
    const tgNonce = 'TG47A-20260709T142255Z';
    await withQueue(
      [
        queueRow(`/reject ${tgNonce}`, { update_id: 1, message_id: 11 }),
        queueRow(`/approve ${CHAT_A}`, { update_id: 2, message_id: 12 }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(tgNonce);
        expect(serialized).not.toContain(CHAT_A);
        expect(result.routes.every((route) => !Object.hasOwn(route, 'approval_id_or_alias'))).toBe(true);
        expect(result.routes.every((route) => route.dedupe_strategy === 'protected_command_bypass')).toBe(true);
      },
    );
  });

  it('uses strict UTC timestamps, deterministic ordering, and isolates invalid fallback timestamps', async () => {
    const repeated = 'build strict timestamp module';
    const rows = [
      queueRow(repeated, { update_id: 1, message_id: 11, received_at: '2026-07-10T09:00:00.123456Z' }),
      queueRow(repeated, { update_id: 2, message_id: 12, received_at: '2026-07-10T09:00:00.123456Z' }),
      queueRow(repeated, { update_id: 3, message_id: 13, received_at: '2026-02-30T09:00:00Z' }),
      queueRow(repeated, { update_id: 4, message_id: 14, received_at: '2026-07-10T09:00:00' }),
      queueRow(repeated, { update_id: 5, message_id: 15, received_at: '2026-07-10T09:00:00+10:00' }),
      queueRow(repeated, { update_id: 6, message_id: 16, received_at: 'not-a-timestamp' }),
      queueRow(repeated, { update_id: 7, message_id: 17, received_at: undefined }),
    ];
    await withQueue(rows, async ({ queuePath }) => {
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
      expect(result.routes.map((route) => route.received_at_valid)).toEqual([true, true, false, false, false, false, false]);
      expect(result.routes.map((route) => route.downstream_eligible)).toEqual([true, false, false, false, false, false, false]);
      expect(result.dedupe_previews[0].canonical_row_index).toBe(1);
      expect(result.dedupe_previews[0].duplicate_row_indexes).toEqual([2]);
      expect(result.dedupe_previews.slice(1).every((preview) => preview.suppressed_duplicate_count === 0)).toBe(true);
      expect(result.dedupe_previews.map((preview) => preview.downstream_eligible)).toEqual([true, false, false, false, false, false]);
      expect(result.canonical_count).toBe(6);
      expect(result.downstream_eligible_count).toBe(1);
    });
  });

  it('accepts one-to-nine UTC fractional digits and rejects ten', async () => {
    await withQueue(
      [
        queueRow('build fraction-one module', { update_id: 1, message_id: 11, received_at: '2026-07-10T09:00:00.1Z' }),
        queueRow('build fraction-nine module', { update_id: 2, message_id: 12, received_at: '2026-07-10T09:00:00.123456789Z' }),
        queueRow('build fraction-ten module', { update_id: 3, message_id: 13, received_at: '2026-07-10T09:00:00.1234567890Z' }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.map((route) => route.received_at_valid)).toEqual([true, true, false]);
        expect(result.routes.map((route) => route.downstream_eligible)).toEqual([true, true, false]);
        expect(result.downstream_eligible_count).toBe(2);
      },
    );
  });

  it('keeps explicit nonce grouping deterministic when timestamps are invalid', async () => {
    await withQueue(
      [
        queueRow('nonce:invalid-time build module', { update_id: 1, message_id: 11, received_at: 'bad-one' }),
        queueRow('nonce:invalid-time build module again', { update_id: 2, message_id: 12, received_at: 'bad-two' }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.dedupe_previews).toHaveLength(1);
        expect(result.dedupe_previews[0].canonical_row_index).toBe(1);
        expect(result.dedupe_previews[0].duplicate_row_indexes).toEqual([2]);
        expect(result.dedupe_previews[0].downstream_eligible).toBe(false);
        expect(result.routes.every((route) => route.downstream_eligible === false)).toBe(true);
      },
    );
  });

  it('anchors fallback windows to the canonical event and gives later groups distinct keys', async () => {
    const text = 'build anchored fallback module';
    await withQueue(
      [
        queueRow(text, { update_id: 1, message_id: 11, received_at: '2026-07-10T09:00:00Z' }),
        queueRow('  build   anchored fallback\r\nmodule ', { update_id: 2, message_id: 12, received_at: '2026-07-10T09:10:00Z' }),
        queueRow(text, { update_id: 3, message_id: 13, received_at: '2026-07-10T09:20:00Z' }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.dedupe_previews).toHaveLength(2);
        expect(result.dedupe_previews[0].canonical_row_index).toBe(1);
        expect(result.dedupe_previews[0].duplicate_row_indexes).toEqual([2]);
        expect(result.dedupe_previews[1].canonical_row_index).toBe(3);
        expect(result.dedupe_previews[1].duplicate_row_indexes).toEqual([]);
        expect(result.dedupe_previews[0].dedupe_key).not.toBe(result.dedupe_previews[1].dedupe_key);
      },
    );
  });

  it('aligns preview, route, and top-level downstream eligibility', async () => {
    await withQueue(
      [
        queueRow('build eligibility module', { update_id: 1, message_id: 11, chat_id: CHAT_A }),
        queueRow('build eligibility module', { update_id: 2, message_id: 12, chat_id: CHAT_A }),
        queueRow('build wrong-chat module', { update_id: 3, message_id: 13, chat_id: CHAT_B }),
        queueRow('/approve edit1', { update_id: 4, message_id: 14, chat_id: CHAT_A }),
      ],
      async ({ queuePath }) => {
        const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: CHAT_A, dedupePreview: true });
        expect(result.routes.map((route) => route.downstream_eligible)).toEqual([true, false, false, true]);
        expect(result.routes.map((route) => route.suppressed_duplicate)).toEqual([false, true, false, false]);
        expect(result.dedupe_previews.map((preview) => preview.downstream_eligible)).toEqual([true, false, true]);
        expect(result.downstream_eligible_count).toBe(2);
        expect(result.downstream_eligible_count).toBe(result.routes.filter((route) => route.downstream_eligible).length);
      },
    );
  });

  it('CLI --dedupe-preview is dry/preview-only and writes no output JSONL', async () => {
    await withQueue(
      [
        queueRow('TGQ: nonce:cli-1 build module', { update_id: 1, message_id: 11 }),
        queueRow('TGQ: nonce:cli-1 build module', { update_id: 2, message_id: 12 }),
      ],
      async ({ tempDir, queuePath }) => {
        const outputPath = path.join(tempDir, 'must-not-exist.jsonl');
        const originalWrite = process.stdout.write;
        const writes = [];
        try {
          process.stdout.write = (chunk) => {
            writes.push(String(chunk));
            return true;
          };
          const result = await runTelegramUpdateRouterWorkerCli([
            '--queue-jsonl', queuePath,
            '--output-jsonl', outputPath,
            '--dry-run',
            '--dedupe-preview',
            '--registered-chat-id', CHAT_A,
            '--json',
          ]);
          const parsed = JSON.parse(writes.join(''));
          expect(result.dedupe_enabled).toBe(true);
          expect(parsed.suppressed_duplicate_count).toBe(1);
          expect(parsed.output_jsonl_written).toBe(false);
          expect(await pathExists(outputPath)).toBe(false);
          expectPreviewOnly(parsed);
        } finally {
          process.stdout.write = originalWrite;
        }
      },
    );
  });

  it('CLI --dedupe-preview prevents output writes without --dry-run', async () => {
    await withQueue([queueRow('nonce:cli-safe build module')], async ({ tempDir, queuePath }) => {
      const outputPath = path.join(tempDir, 'must-not-exist.jsonl');
      const originalWrite = process.stdout.write;
      try {
        process.stdout.write = () => true;
        const result = await runTelegramUpdateRouterWorkerCli([
          '--queue-jsonl', queuePath,
          '--output-jsonl', outputPath,
          '--dedupe-preview',
          '--registered-chat-id', CHAT_A,
          '--json',
        ]);
        expect(result.output_jsonl_written).toBe(false);
        expect(await pathExists(outputPath)).toBe(false);
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('accepts a valid signed Telegram chat ID operand without weakening flag swallowing checks', async () => {
    const workerPath = new URL('./telegram-update-router-worker.mjs', import.meta.url);
    const negativeChatId = '-1001234567890';
    await withQueue([queueRow('build signed-chat fixture', { chat_id: negativeChatId })], async ({ tempDir, queuePath }) => {
      const child = spawnSync(process.execPath, [
        workerPath.pathname,
        '--queue-jsonl', queuePath,
        '--registered-chat-id', negativeChatId,
        '--dry-run',
        '--dedupe-preview',
        '--json',
      ], { cwd: tempDir, encoding: 'utf8' });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.routes[0]).toMatchObject({ status: 'routed', downstream_eligible: true });
      expect(child.stdout).not.toContain(negativeChatId);
    });
  });

  it('rejects missing or flag-like CLI option values before safety flags can be swallowed', async () => {
    const workerPath = new URL('./telegram-update-router-worker.mjs', import.meta.url);
    await withQueue([queueRow('build CLI operand fixture')], async ({ tempDir, queuePath }) => {
      const swallowedDedupePath = path.join(tempDir, '--dedupe-preview');
      const swallowedDryRunPath = path.join(tempDir, '--dry-run');
      const cases = [
        ['--queue-jsonl', queuePath, '--output-jsonl', '--dedupe-preview', '--json'],
        ['--queue-jsonl', queuePath, '--output-jsonl', '--dry-run', '--json'],
        ['--queue-jsonl', '--unknown-option', '--json'],
      ];
      for (const args of cases) {
        const child = spawnSync(process.execPath, [workerPath.pathname, ...args], { cwd: tempDir, encoding: 'utf8' });
        expect(child.status).toBe(1);
        expect(child.stdout).toBe('');
        expect(child.stderr).toContain('requires a value');
      }
      expect(await pathExists(swallowedDedupePath)).toBe(false);
      expect(await pathExists(swallowedDryRunPath)).toBe(false);
    });
  });

  it('unknown CLI options exit 1 with no normal JSON stdout', () => {
    const workerPath = new URL('./telegram-update-router-worker.mjs', import.meta.url);
    const child = spawnSync(process.execPath, [workerPath.pathname, '--unknown-option', '--json'], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('Unsupported argument');
  });
});
