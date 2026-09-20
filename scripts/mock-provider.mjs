#!/usr/bin/env node
/**
 * 本地 mock model provider —— 让协议契约测试完全离线、无凭据可跑。
 *
 * 它实现 OpenAI Responses API 的 SSE 流式子集，按脚本返回「一次 exec_command 函数调用」。
 * 配合 `sandbox_permissions: require_escalated` 触发 app-server 向客户端发起
 * `item/commandExecution/requestApproval`，从而在不接触真实模型的前提下端到端验证审批链路。
 *
 * 用法：
 *   node scripts/mock-provider.mjs --port 8791 [--script escalated]
 *
 * --script 取值：
 *   escalated  发出需要提权的命令调用（默认，用于验证审批请求）
 *   plain      发出普通命令调用（沙箱内直接执行，不触发审批）
 *   message    只回一条文本消息（用于验证 turn/completed 正常收尾）
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8791' },
    script: { type: 'string', default: 'escalated' },
    quiet: { type: 'boolean', default: false },
  },
});

const PORT = Number(values.port);
const SCRIPT = values.script;
const QUIET = values.quiet;

let requestCount = 0;
const log = (...a) => { if (!QUIET) console.error('[mock-provider]', ...a); };

// 供契约测试与人工核对：把收到的请求数打到 stdout 作为机器可读的收尾统计。
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ requests: requestCount }) + '\n');
  process.exit(0);
});

/** 每次请求返回的模型输出：一条 function_call 或一条 message。 */
function buildOutput() {
  if (SCRIPT === 'message') {
    return {
      type: 'message',
      id: 'msg_mock_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'mock reply', annotations: [] }],
    };
  }

  const args = {
    cmd: SCRIPT === 'escalated' ? 'echo kcode-approval-probe' : 'echo kcode-plain-probe',
    workdir: null,
    yield_time_ms: 3000,
  };
  if (SCRIPT === 'escalated') {
    args.sandbox_permissions = 'require_escalated';
    args.justification = 'kcode contract test: verify approval round-trip';
  }

  return {
    type: 'function_call',
    id: 'fc_mock_1',
    call_id: 'call_mock_1',
    name: 'exec_command',
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

function sse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 请求体，忽略 */ }

    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requests: requestCount }));
      return;
    }

    if (!req.url.endsWith('/responses')) {
      log('非 responses 路径:', req.method, req.url);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const input = Array.isArray(parsed.input) ? parsed.input : [];
    const nCalls = input.filter((i) => i.type === 'function_call').length;
    requestCount++;
    log(`turn 请求 model=${parsed.model} 已有 function_call=${nCalls}`);

    // 第二次及以后的请求：视为工具结果已回填，收尾给出最终文本。
    // 这样多轮 turn 不会无限循环调用工具。
    const output = nCalls >= 1
      ? {
          type: 'message',
          id: 'msg_mock_final',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'kcode mock: done', annotations: [] }],
        }
      : buildOutput();

    const responseId = `resp_mock_${Date.now()}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    sse(res, {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', model: parsed.model, output: [] },
    });
    sse(res, {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...output, status: 'in_progress' },
    });
    sse(res, {
      type: 'response.output_item.done',
      output_index: 0,
      item: output,
    });
    sse(res, {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        model: parsed.model,
        output: [output],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT} script=${SCRIPT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
