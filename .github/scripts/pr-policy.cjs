'use strict';

const MARKER = '<!-- agentrouter-pr-review -->';
const CHECK_NAME = 'PR policy';

function assessPullRequest(pr, files) {
  const errors = [];
  const warnings = [];
  const body = (pr.body || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const dependencyUpdate = pr.user?.login === 'dependabot[bot]';
  if (!/^(feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?:\s+\S/i.test(pr.title || '')) {
    errors.push('标题使用 Conventional Commits，例如 fix(responses): preserve assistant output_text。');
  }
  if (!dependencyUpdate) {
    if (!/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#\d+/i.test(body)) {
      errors.push('描述中关联本仓库 Issue：Fixes #123 或 Refs #123。');
    }
    const sections = [
      ['改动说明', /^##\s+(?:改动|变更|Summary|Changes)/im],
      ['验证证据', /^##\s+(?:验证|测试|Test|Validation)/im],
      ['风险与兼容性', /^##\s+(?:风险|兼容|Risk|Compatibility)/im],
    ];
    for (const [label, pattern] of sections) {
      const heading = pattern.exec(body);
      const section = heading && body.slice(heading.index).split(/\r?\n/).slice(1).join('\n').split(/^##\s/m)[0].replace(/^\s*-\s*\[[ xX]\].*$/gm, '').trim();
      if (!section || /^(?:待补充|TODO|N\/A|-\s*\[\s*\])$/i.test(section)) {
        errors.push('补充「' + label + '」二级标题和实际内容，不能只保留模板占位符。');
      }
    }
    if (!/-\s*\[[xX]\]\s*我确认未提交真实凭据/.test(body)) {
      errors.push('检查并勾选：我确认未提交真实凭据、Cookie、Token 或用户对话。');
    }
  }
  const names = files.map(file => file.filename);
  if (names.some(name => /^(request|content-filter|body-inspection)\.mjs$/.test(name))) {
    warnings.push('请求/内容边界：人工核对 assistant output_text、call_id、opaque reasoning/引用、显式降级及不自动重试约定；补独立反例，不仅改旧测试预期。');
  }
  if (names.some(name => /^(session|github-cookie|oauth-guidance|index|local-checkin)\.mjs$/.test(name))) {
    warnings.push('认证/运行时：检查凭据脱敏、域边界、交互登录、签到限流和真实网络副作用。');
  }
  if (names.some(name => name.startsWith('.github/'))) {
    warnings.push('自动化：检查最小权限、固定 Action SHA 和 fork 隔离；pull_request_target 绝不执行 PR 代码或下载 PR 产物。');
  }
  if (names.some(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')) && !names.some(name => /\.test\.(?:mjs|cjs|py)$/.test(name))) {
    warnings.push('生产逻辑有变化但未见测试文件变化：需要解释并提供回归证据。');
  }
  if (files.reduce((sum, file) => sum + (file.additions || 0) + (file.deletions || 0), 0) > 800) {
    warnings.push('较大 diff（>800 行）：建议拆分独立变更后审查。');
  }
  return { errors, warnings, dependencyUpdate };
}

async function reviewPullRequest({ github, context, core }) {
  const repo = context.repo;
  // Read latest metadata because synchronize/edited events can queue out of order.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: context.payload.pull_request.number });
  if (pr.state !== 'open') return;
  const { data: check } = await github.rest.checks.create({ ...repo, name: CHECK_NAME, head_sha: pr.head.sha, status: 'in_progress' });
  try {
    const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
    const result = assessPullRequest(pr, files);
    if (files.length < pr.changed_files) result.errors.push('GitHub 文件列表不完整，无法完成审查；请拆分 PR。');
    const lines = [MARKER, '## 自动 PR 审查', '', '审查提交：' + pr.head.sha, '',
      '**这是规则检查与风险分流，不是 AI 语义审查，也不代表批准合并。**',
      '测试矩阵和 CodeQL 结果请查看 Checks；仍须代码所有者人工审查。', '',
      result.errors.length ? '### 需要补充（阻止合并）' : '### 贡献规范检查通过',
      ...result.errors.map(text => '- ' + text), '', '### 人工审查重点',
      ...(result.warnings.length ? result.warnings.map(text => '- ' + text) : ['- 未命中特定规则；仍需检查正确性、边界与测试覆盖。']),
      '', '贡献流程见仓库 CONTRIBUTING.md。',
    ];
    const body = lines.join('\n');
    const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: pr.number, per_page: 100 });
    const previous = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER));
    if (previous) await github.rest.issues.updateComment({ ...repo, comment_id: previous.id, body });
    else await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
    await github.rest.checks.update({ ...repo, check_run_id: check.id, status: 'completed',
      conclusion: result.errors.length ? 'failure' : 'success',
      output: { title: result.errors.length ? '请补充贡献规范要求' : '贡献规范检查通过，仍需人工审查', summary: body },
    });
    if (result.errors.length) core.setFailed('PR contribution policy not satisfied');
  } catch (error) {
    await github.rest.checks.update({ ...repo, check_run_id: check.id, status: 'completed', conclusion: 'failure',
      output: { title: '自动审查未完成', summary: 'GitHub API 审查失败；请查看 Actions 日志后重跑，不得视为通过。' },
    });
    throw error;
  }
}

module.exports = { assessPullRequest, reviewPullRequest };
