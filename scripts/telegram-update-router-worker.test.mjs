import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTelegramUpdateRouterWorker, runTelegramUpdateRouterWorkerCli } from './telegram-update-router-worker.mjs';

const REGISTERED_CHAT_ID = '123456789';

function queueRow(text, overrides = {}) {
  return {
    update_id: overrides.update_id ?? 1001,
    message_id: overrides.message_id ?? 2002,
    chat_id: overrides.chat_id ?? Number(REGISTERED_CHAT_ID),
    text,
    received_at: overrides.received_at ?? '2026-07-08T10:00:00.000Z',
    source: 'hermes-gateway',
    sanitized: true,
    ...overrides,
  };
}

async function withTempDir(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tg-router-worker-'));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeQueue(tempDir, rowsOrRaw) {
  const queuePath = path.join(tempDir, 'queue.jsonl');
  const content = Array.isArray(rowsOrRaw) ? `${rowsOrRaw.map((row) => JSON.stringify(row)).join('\n')}\n` : rowsOrRaw;
  await writeFile(queuePath, content, 'utf8');
  return queuePath;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expectNoWorkerSideEffects(result) {
  expect(result.telegramPolled).toBe(false);
  expect(result.telegramMessagesSent).toBe(false);
  expect(result.telegramStateWrites).toBe(false);
  expect(result.telegramQueueStateWrites).toBe(false);
  expect(result.approvalDecisionWrites).toBe(false);
  expect(result.offsetWrites).toBe(false);
  expect(result.githubCalls).toBe(false);
  expect(result.githubWrites).toBe(false);
  expect(result.obsidianKanbanWrites).toBe(false);
  expect(result.auditWrites).toBe(false);
  expect(result.durableStoreWrites).toBe(false);
  expect(result.reportWrites).toBe(false);
  expect(result.indexWrites).toBe(false);
  expect(result.systemdServiceChanges).toBe(false);
  expect(result.liveGatewayChanges).toBe(false);
  expect(result.codeEdits).toBe(false);
}

describe('telegram update router worker', () => {
  it('routes sanitized normal text rows through router preview to natural_language_task_intake/code_change', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('build a queue worker module for Telegram updates')]);
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: REGISTERED_CHAT_ID });

      expect(result.ok).toBe(true);
      expect(result.preview_only).toBe(true);
      expect(result.routed_count).toBe(1);
      expect(result.routes[0].route_type).toBe('natural_language_task_intake');
      expect(result.routes[0].classification).toBe('code_change');
      expect(result.routes[0].intent_type).toBe('code_change');
      expect(result.routes[0].approval_required).toBe(true);
      expect(result.routes[0].chat_id_redacted).toBe('[REDACTED]');
      expectNoWorkerSideEffects(result);
    });
  });

  it('routes approve command rows to approval_command without decision writes', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('/approve edit1')]);
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: REGISTERED_CHAT_ID });

      expect(result.routed_count).toBe(1);
      expect(result.routes[0].route_type).toBe('approval_command');
      expect(result.routes[0].classification).toBe('approval_command');
      expect(result.routes[0].approval_id_or_alias).toBe('edit1');
      expect(result.routes[0].decision_preview).toBe('approved');
      expect(result.routes[0].approvalDecisionWrites).toBe(false);
      expectNoWorkerSideEffects(result);
    });
  });

  it('ignores wrong chat when registered chat id is supplied without leaking text', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('build private secret thing', { chat_id: 999999999 })]);
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: REGISTERED_CHAT_ID });

      expect(result.routed_count).toBe(0);
      expect(result.ignored_count).toBe(1);
      expect(result.routes[0].status).toBe('ignored');
      expect(result.routes[0].reason).toBe('WRONG_CHAT');
      expect(JSON.stringify(result)).not.toContain('build private secret thing');
      expect(JSON.stringify(result)).not.toContain('999999999');
      expectNoWorkerSideEffects(result);
    });
  });

  it('skips duplicate update_id/message_id pairs', async () => {
    await withTempDir(async (tempDir) => {
      const duplicate = queueRow('build duplicate module', { update_id: 44, message_id: 55 });
      const queuePath = await writeQueue(tempDir, [duplicate, { ...duplicate, text: 'build duplicate module again' }]);
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, dryRun: true, registeredChatId: REGISTERED_CHAT_ID });

      expect(result.row_count).toBe(2);
      expect(result.routes).toHaveLength(1);
      expect(result.skipped_duplicate_count).toBe(1);
      expect(result.skipped[0].reason).toBe('DUPLICATE_UPDATE_MESSAGE');
      expectNoWorkerSideEffects(result);
    });
  });

  it('fails closed on malformed JSONL before writing output', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, `${JSON.stringify(queueRow('/approve edit1'))}\n{not json}\n`);
      const outputPath = path.join(tempDir, 'out.jsonl');

      await expect(runTelegramUpdateRouterWorker({ queueJsonl: queuePath, outputJsonl: outputPath })).rejects.toThrow('Malformed JSONL at line 2');
      expect(await pathExists(outputPath)).toBe(false);
    });
  });

  it('dry-run writes no output file even when output-jsonl is supplied', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('build dry run worker')]);
      const outputPath = path.join(tempDir, 'dry-run-output.jsonl');
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, outputJsonl: outputPath, dryRun: true, registeredChatId: REGISTERED_CHAT_ID });

      expect(result.output_jsonl_written).toBe(false);
      expect(result.outputJsonlWrites).toBe(false);
      expect(result.wrote).toEqual([]);
      expect(await pathExists(outputPath)).toBe(false);
      expectNoWorkerSideEffects(result);
    });
  });

  it('--output-jsonl writes only sanitized routed preview rows to explicit temp path', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('/approve edit1'), queueRow('build worker', { update_id: 2, message_id: 3 })]);
      const outputPath = path.join(tempDir, 'routed.jsonl');
      const result = await runTelegramUpdateRouterWorker({ queueJsonl: queuePath, outputJsonl: outputPath, registeredChatId: REGISTERED_CHAT_ID });
      const rows = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

      expect(result.output_jsonl_written).toBe(true);
      expect(result.wrote).toEqual([outputPath]);
      expect(rows).toHaveLength(2);
      expect(rows[0].sanitized).toBe(true);
      expect(rows[0].queue_source).toBe('hermes-gateway');
      expect(rows[0].chat_id_redacted).toBe('[REDACTED]');
      expect(rows[0]).not.toHaveProperty('text');
      expect(JSON.stringify(rows)).not.toContain(REGISTERED_CHAT_ID);
      expect(result.githubCalls).toBe(false);
      expect(result.telegramMessagesSent).toBe(false);
    });
  });

  it('CLI emits JSON summary for dry-run queue fixture', async () => {
    await withTempDir(async (tempDir) => {
      const queuePath = await writeQueue(tempDir, [queueRow('build CLI worker')]);
      const originalWrite = process.stdout.write;
      const writes = [];
      try {
        process.stdout.write = (chunk) => {
          writes.push(String(chunk));
          return true;
        };
        const result = await runTelegramUpdateRouterWorkerCli(['--queue-jsonl', queuePath, '--dry-run', '--registered-chat-id', REGISTERED_CHAT_ID, '--json']);
        const parsed = JSON.parse(writes.join(''));
        expect(result.routed_count).toBe(1);
        expect(parsed.routed_count).toBe(1);
        expect(parsed.dry_run).toBe(true);
        expect(parsed.output_jsonl_written).toBe(false);
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('runtime worker file contains no Telegram polling/send, GitHub, service, or live-state surfaces', async () => {
    const runtime = await readFile(new URL('./telegram-update-router-worker.mjs', import.meta.url), 'utf8');
    const forbidden = [
      'get' + 'Updates',
      'send' + 'Message',
      'api.telegram.org',
      'systemctl',
      'hermes-' + 'gateway.service',
      'github.com',
      'api.github.com',
      '.git',
      'append' + 'File',
      'execFile',
      'spawn',
    ];
    for (const token of forbidden) expect(runtime).not.toContain(token);
  });
});
