import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRouterAuthPlugin, _internal } from './index.mjs';

const plugin = await AgentRouterAuthPlugin();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const apiMethod = (p) => p.auth.methods.find((m) => m.type === 'api');
const prompt = (p, key) => apiMethod(p).prompts.find((x) => x.key === key);

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

test('A key pasted into the endpoint question is refused there and ignored at request time', async () => {
  // The question is where the key used to go, so a key pasted into it is the
  // mistake this guards: told to the user while they can still fix it, and
  // never used to build a base even when it is already stored.
  const validate = prompt(plugin, 'endpoint').validate;
  assert.equal(validate(''), undefined);
  assert.equal(validate('https://agentrouter.org'), undefined);
  assert.match(validate('sk-example'), /不要在这里填/);

  const { calls } = await readUsage(
    { key: 'sk-example', metadata: { endpoint: 'sk-example' } },
    [json({ total_usage: 0 })],
  );
  assert.equal(calls[0].url, 'https://agentrouter.org/v1/dashboard/billing/usage');
});

test('The Codex headers are sent unless the provider switch is turned off', async () => {
  // On — and on a host too old to offer the switch — the gateway sees the
  // client it admits. Off, the user's own headers are all that go.
  const withSwitch = (on) => AgentRouterAuthPlugin({ magpie: { option: () => on } });
  try {
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    await withSwitch(false);
    const off = _internal.headersOf({}, {});
    assert.equal(off['User-Agent'], undefined);
    assert.equal(off.Accept, 'application/json');
    assert.equal(
      _internal.headersOf({}, { metadata: { headers: 'User-Agent: mine' } })['User-Agent'],
      'mine',
    );

    await withSwitch(true);
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    // A host from before the switch hands over no reader at all.
    await AgentRouterAuthPlugin();
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');
  } finally {
    await withSwitch(true);
  }
});

test('A retired model is never advertised back, whichever path lists it', async () => {
  // magpie's cached models.dev entry for this vendor still names models the
  // site has retired. The plugin's own list is what it answers with when the
  // vendor's list cannot be read, so those names cannot come back through it.
  const retired = ['claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash', 'glm-5.3'];
  const declared = Object.keys(_internal.declaredModels());
  assert.deepEqual(declared, ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  for (const id of retired) assert.ok(!declared.includes(id), `${id} must not be declared`);

  // No account yet: the vendor's list cannot be asked, and the row keeps the
  // plugin's list rather than the row's.
  const row = { models: { 'claude-opus-5': { name: 'x' }, 'gpt-6-astra': { name: 'y' } } };
  const listed = await plugin.provider.models(row);
  for (const id of retired) assert.ok(!(id in listed), `${id} must not be listed`);

  // The vendor refuses the list: same answer, not the row's.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const fell = await plugin.provider.models(row, { auth: { key: 'sk-example' } });
    assert.deepEqual(Object.keys(fell), declared);
  } finally {
    globalThis.fetch = original;
  }
});

test('A content-filter refusal is explained, not left looking like a rate limit', async () => {
  // The vendor's filter answers refused text with 400 content-blocked. Waiting
  // or retrying never clears it, so an agent that reads it as a transient
  // gateway failure burns its budget repeating the same text forever.
  const original = globalThis.fetch;
  const blocked = JSON.stringify({
    error: {
      code: 'content-blocked',
      message: 'content-blocked (request id: abc)',
      type: 'agent_router_api_error',
    },
  });
  globalThis.fetch = async () =>
    new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(text, /content-blocked/);
    assert.match(text, /内容过滤器/);
    assert.match(text, /改写/);

    // magpie decides "may another provider retry this?" by matching quota /
    // rate-limit words in the body (fallback.go's retryable/quotaWords). If
    // the note reads like one of those, a hard refusal is retried on every
    // account and then fails over — surfacing as another provider's 429.
    // So the note must not contain any of them.
    const quotaWords =
      /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;
    assert.equal(quotaWords.test(text), false, 'the refusal must not read like a quota error');
  } finally {
    globalThis.fetch = original;
  }
});

test('Any other refusal is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), body);
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
