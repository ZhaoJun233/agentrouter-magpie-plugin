import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRouterAuthPlugin } from './index.mjs';

const plugin = await AgentRouterAuthPlugin();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('GitHub login requires a system access token before requesting authorization', async () => {
  const method = plugin.auth.methods.find((m) => m.type === 'oauth');
  await assert.rejects(() => method.authorize({ site: 'org', accessToken: '  ' }), /系统访问令牌/);
});

test('GitHub login saves the entered token and never regenerates it', async () => {
  const method = plugin.auth.methods.find((m) => m.type === 'oauth');
  const original = globalThis.fetch;
  const calls = [];
  const responses = [
    json({ success: true, data: 'oauth-state' }),
    json({ data: { github_client_id: 'example', server_address: 'https://agentrouter.org' } }),
    new Response(JSON.stringify({ success: true, data: { id: 123, access_token: 'site-token' } }), {
      headers: { 'Set-Cookie': 'session=example; Path=/; HttpOnly' },
    }),
    json({ success: true, data: { items: [{ status: 1, key: 'sk-example' }] } }),
  ];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    return responses.shift();
  };
  try {
    const authorization = await method.authorize({ site: 'org', accessToken: '  entered-token  ' });
    const result = await authorization.callback('examplecode');
    assert.equal(result.type, 'success');
    assert.equal(result.metadata.accessToken, 'entered-token');
    assert.equal(result.metadata.cookie, 'session=example');
    assert.equal(result.metadata.userId, '123');
    assert.equal(result.key, 'sk-example');
    assert.equal(calls.at(-1).headers.Authorization, 'entered-token');
    assert.ok(calls.every((call) => !call.url.includes('/api/user/token')));
  } finally {
    globalThis.fetch = original;
  }
});

async function readUsage(auth, responses, provider = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${url}`);
    return response;
  };
  try {
    return { usage: await plugin.auth.usage(async () => auth, provider), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('Cookie-only account reads remaining balance and real consumption', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: 75000000, used_quota: 25000000 } })],
  );
  assert.equal(calls[0].headers.Cookie, 'session=example');
  assert.equal(calls[0].headers['New-Api-User'], '123');
  assert.equal(usage.balance, '$150.00');
  assert.equal(usage.windows[0].amount, 50);
  assert.equal(usage.windows[0].limit, 200);
  assert.equal(usage.windows[0].used, 25);
});

test('WAF-blocked balance falls back to account consumption without inventing remaining quota', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [new Response('<!doctype html><html>captcha</html>'), json({ success: true, data: { quota: 4500000 } })],
  );
  assert.ok(calls[1].url.endsWith('/api/log/self/stat'));
  assert.match(usage.error, /累计消耗 \$9\.00/);
  assert.match(usage.error, /剩余额度未知/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Missing quota fields are not zero balance; key usage is converted from cents', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { accessToken: 'example', userId: '123', endpoint: 'https://relay.example' } },
    [json({ success: true, data: {} }), json({ success: false }), json({ total_usage: 12345.67 })],
  );
  assert.equal(calls[2].url, 'https://relay.example/v1/dashboard/billing/usage');
  assert.equal(calls[2].headers.Authorization, 'Bearer sk-example');
  assert.match(usage.error, /累计消耗 \$123\.46/);
  assert.equal(usage.balance, undefined);
});

test('Key-only account can report zero consumption without claiming zero balance', async () => {
  const { usage, calls } = await readUsage({ key: 'sk-example' }, [json({ total_usage: 0 })]);
  assert.equal(calls.length, 1);
  assert.match(usage.error, /累计消耗 \$0\.00/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Successful login without quota does not crash or invent balance', async () => {
  const { usage } = await readUsage(
    { metadata: { username: 'example', password: 'example' } },
    [json({ success: true, data: { checked_in: true } })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});

test('Password login supplies balance when user read is blocked', async () => {
  const { usage } = await readUsage(
    { metadata: { accessToken: 'example', username: 'example', password: 'example' } },
    [new Response('<html>captcha</html>'), json({ success: true, data: { quota: 0, used_quota: 500000, username: 'example' } })],
  );
  assert.equal(usage.balance, '$0.00');
  assert.equal(usage.plan, 'example');
  assert.equal(usage.windows[0].used, 100);
});

test('Malformed account and billing amounts stay unknown', async () => {
  const { usage } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: null, used_quota: 1 } }), json({ data: { quota: null } }), json({ total_usage: -1 })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});
