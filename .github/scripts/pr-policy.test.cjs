'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessPullRequest, reviewPullRequest } = require('./pr-policy.cjs');
const good = {
  number: 3, state: 'open', title: 'fix(responses): preserve text',
  user: { login: 'contributor' }, head: { sha: 'current-head' }, changed_files: 0,
  body: [
    'Refs #2', '## 改动说明', '保持 assistant 文本类型。',
    '## 验证证据', 'node --test: 278 passed',
    '## 风险与兼容性', '没有新增网络调用；保持 opaque state。',
    '- [x] 我确认未提交真实凭据、Cookie、Token 或用户对话。',
  ].join('\n'),
};
test('valid contribution passes', () => assert.deepEqual(assessPullRequest(good, []), { errors: [], warnings: [], dependencyUpdate: false }));
test('missing metadata fails all requirements', () => assert.equal(assessPullRequest({ title: 'stuff' }, []).errors.length, 6));
test('comments and empty placeholders are not evidence', () => {
  const pr = { ...good, body: 'Refs #2\n## 改动说明\n<!-- fake evidence -->\n## 验证证据\nTODO\n## 风险与兼容性\nN/A\n' };
  assert.equal(assessPullRequest(pr, []).errors.length, 4);
});
test('checked declaration alone is not risk evidence', () => {
  assert.equal(assessPullRequest({ ...good, body: good.body.replace('没有新增网络调用；保持 opaque state。', '') }, []).errors.length, 1);
});
test('unchecked secret confirmation fails', () => assert.equal(assessPullRequest({ ...good, body: good.body.replace('[x]', '[ ]') }, []).errors.length, 1));
test('English headings, fixes reference and breaking conventional title pass', () => {
  const body = good.body.replace('改动说明', 'Summary').replace('验证证据', 'Validation').replace('风险与兼容性', 'Risk').replace('Refs #2', 'Fixes #2');
  assert.equal(assessPullRequest({ ...good, title: 'feat(api)!: new behavior', body }, []).errors.length, 0);
});
test('only actual dependabot account gets body exemption', () => {
  assert.equal(assessPullRequest({ title: 'chore(deps): bump', user: { login: 'dependabot[bot]' } }, []).errors.length, 0);
  assert.equal(assessPullRequest({ title: 'chore(deps): bump', user: { login: 'dependabot-lookalike' } }, []).errors.length, 5);
});
test('request, runtime, automation, missing tests and large diffs trigger risk advice', () => {
  const files = [{ filename: 'request.mjs', additions: 801 }, { filename: 'index.mjs' }, { filename: '.github/workflows/ci.yml' }];
  assert.equal(assessPullRequest(good, files).warnings.length, 5);
  assert.equal(assessPullRequest(good, [...files, { filename: 'request.test.mjs' }]).warnings.length, 4);
});
function harness({ pr = good, files = [], comments = [], failList = false } = {}) {
  const events = [];
  const rest = {
    pulls: { get: async () => ({ data: pr }), listFiles: 'files' },
    checks: {
      create: async args => { events.push(['start', args]); return { data: { id: 42 } }; },
      update: async args => events.push(['finish', args]),
    },
    issues: {
      listComments: 'comments',
      updateComment: async args => events.push(['edit', args]),
      createComment: async args => events.push(['comment', args]),
    },
  };
  return {
    events,
    github: { rest, paginate: async method => {
      if (method === 'files' && failList) throw new Error('API unavailable');
      return method === 'files' ? files : comments;
    } },
    context: { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 3, head: { sha: 'stale-event' } } } },
    core: { setFailed: message => events.push(['failed', message]) },
  };
}
test('check targets current API head not stale event; success comment posted', async () => {
  const h = harness(); await reviewPullRequest(h);
  assert.equal(h.events[0][1].head_sha, 'current-head');
  assert.equal(h.events.at(-1)[1].conclusion, 'success');
  assert.match(h.events[1][1].body, /不是 AI 语义审查/);
});
test('updates only its own marked bot comment', async () => {
  const marker = '<!-- agentrouter-pr-review -->';
  const h = harness({ comments: [{ id: 9, user: { login: 'attacker' }, body: marker }, { id: 10, user: { login: 'github-actions[bot]' }, body: marker }] });
  await reviewPullRequest(h);
  assert.equal(h.events[1][0], 'edit'); assert.equal(h.events[1][1].comment_id, 10);
});
test('incomplete paginated files fail closed', async () => {
  const h = harness({ pr: { ...good, changed_files: 3001 } }); await reviewPullRequest(h);
  assert.equal(h.events.at(-2)[1].conclusion, 'failure'); assert.equal(h.events.at(-1)[0], 'failed');
});
test('API error completes check as failure and rethrows', async () => {
  const h = harness({ failList: true }); await assert.rejects(reviewPullRequest(h), /API unavailable/);
  assert.equal(h.events.at(-1)[1].conclusion, 'failure');
});
test('closed PR does not create checks or comments', async () => {
  const h = harness({ pr: { ...good, state: 'closed' } }); await reviewPullRequest(h); assert.deepEqual(h.events, []);
});
