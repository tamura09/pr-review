const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { test } = require('node:test');

// Execute the actual inline publisher. Reusable workflows check out the caller's
// repository, so the publisher cannot import a script from this repository.
const workflow = readFileSync(join(__dirname, '../workflows/pr-review.yml'), 'utf8');
const defaultFindingsState = workflow.match(/      findings_state:\n[\s\S]*?        default: "([^"]+)"/)[1];
const script = workflow.match(/          script: \|\n((?: {12}[^\n]*\n|\n)*)/)[1].replace(/^ {12}/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publish = new AsyncFunction('github', 'context', 'core', 'process', 'require', script);
const runUrl = 'https://github.com/example/repo/actions/runs/123';
const finding = {
  path: 'src/example.ts', line: 42, side: 'RIGHT',
  body: '**境界値で失敗する**\n入力が 0 の場合に例外になるため、境界条件を修正してください。',
};
const result = { summary: '境界値で失敗する', findings: [finding] };
const jsonBlock = value => '```json\n' + JSON.stringify(value) + '\n```';

async function run(options = {}) {
  const isCodex = options.isCodex ?? true;
  const raw = options.raw ?? jsonBlock(options.result ?? result);
  const calls = [];
  const failures = [];
  const errors = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'pr-review-result-test-'));
  const env = {
    RUNNER_TEMP: tempDir,
    SHA: 'reviewed-head', RUN_URL: runUrl, FINDINGS_STATE: defaultFindingsState,
    REVIEWER: isCodex ? 'Codex · test-model · effort medium' : 'Claude · test-model · effort medium',
    IS_CODEX: String(isCodex), REVIEW_DIFF_OUTCOME: 'success',
    EFFORT_OUTCOME: 'success', MODEL_OUTCOME: 'success', CODEX_REVIEW: raw,
    CLAUDE_REVIEW: options.claudeReview ?? JSON.stringify(options.result ?? result),
    ...options.env,
  };
  const api = method => async params => {
    calls.push({ method, params });
    if (options.fail === method) throw new Error(`Simulated ${method} failure`);
    return { data: { id: 88, html_url: 'https://github.com/example/repo/pull/7#pullrequestreview-88' } };
  };
  const github = {
    paginate: async () => { throw new Error('Review history must not be fetched'); },
    rest: {
      pulls: { createReview: api('createReview') },
      issues: {
        createComment: api('createComment'),
      },
      repos: { createCommitStatus: api('createCommitStatus') },
    },
  };
  try {
    await publish(github, {
      repo: { owner: 'example', repo: 'repo' }, payload: { pull_request: { number: 7 } },
    }, { error: message => errors.push(message), setFailed: message => failures.push(message) }, { env }, require);
    const resultPath = join(tempDir, 'pr-review-results', isCodex ? 'codex.md' : 'claude.json');
    return {
      savedResult: existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : undefined,
      calls, failures, errors,
      review: calls.find(call => call.method === 'createReview')?.params,
      summary: calls.find(call => ['createReview', 'createComment'].includes(call.method))?.params,
      status: calls.find(call => call.method === 'createCommitStatus')?.params,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

for (const isCodex of [false, true]) {
  const reviewer = isCodex ? 'Codex' : 'Claude';
  test(`${reviewer}: one summary review with one resolvable thread per finding`, async () => {
    const findings = [finding, { ...finding, line: 9, side: 'LEFT', body: '**削除による不具合**\n既存の呼び出しが失敗します。' }];
    const output = await run({ isCodex, result: { summary: '境界値で失敗する', findings } });
    assert.equal(output.failures.length, 0);
    assert.equal(output.review.event, 'COMMENT');
    assert.equal(output.review.commit_id, 'reviewed-head');
    assert.equal(output.review.comments.length, 2);
    for (const [index, item] of findings.entries()) {
      assert.equal(output.review.comments[index].path, item.path);
      assert.equal(output.review.comments[index].line, item.line);
      assert.equal(output.review.comments[index].side, item.side);
      assert.ok(output.review.comments[index].body.startsWith(item.body));
      assert.ok(output.review.comments[index].body.includes(reviewer));
    }
    assert.ok(output.summary.body.includes('**⚠️ 指摘 2件** — 境界値で失敗する'));
    assert.ok(!output.summary.body.includes('入力が 0'));
    assert.ok(!output.summary.body.includes('```json'));
    assert.equal(output.summary.body.startsWith('<!-- pr-review:codex -->'), isCodex);
    assert.equal(output.status.state, 'failure');
    assert.equal(output.status.context, isCodex ? 'codex-review' : 'claude-review');
    assert.equal(output.status.sha, 'reviewed-head');
    assert.match(output.status.description, /^指摘 2件/);
    assert.equal(output.calls.filter(call => ['createComment'].includes(call.method)).length, 0);
    assert.deepEqual(output.calls.map(call => call.method), ['createReview', 'createCommitStatus']);
  });

  test(`${reviewer}: no findings creates no threads and removes model commentary`, async () => {
    const raw = `確認しました\n${jsonBlock({ summary: '確認結果は表示しない', findings: [] })}\n追加の指摘はありません`;
    const output = await run({ isCodex, raw, result: { summary: '確認結果は表示しない', findings: [] } });
    assert.equal(output.review, undefined);
    assert.ok(output.summary.body.includes('**✅ 指摘なし**'));
    assert.ok(!output.summary.body.includes('確認'));
    assert.ok(!output.summary.body.includes('追加の指摘'));
    assert.equal(output.status.state, 'success');
    assert.equal(output.status.description, '指摘なし');
    assert.equal(output.failures.length, 0);
  });
}

for (const [name, raw] of [
  ['missing JSON', '**✅ 指摘なし**'],
  ['malformed JSON', '```json\n{\n```'],
  ['multiple JSON blocks', `${jsonBlock(result)}\n${jsonBlock(result)}`],
  ['null', jsonBlock(null)],
  ['missing findings', jsonBlock({ summary: '' })],
  ['missing summary', jsonBlock({ findings: [] })],
  ['findings is not an array', jsonBlock({ summary: '', findings: {} })],
  ...[
    { path: '' }, { line: 0 }, { line: 1.5 }, { line: '42' },
    { side: 'BOTH' }, { body: ' ' },
  ].map(change => [`invalid finding ${JSON.stringify(change)}`, jsonBlock({
    ...result, findings: [{ ...finding, ...change }],
  })]),
]) {
  test(`${name} fails without publishing a summary or success`, async () => {
    const output = await run({ raw });
    assert.equal(output.review, undefined);
    assert.equal(output.summary, undefined);
    assert.equal(output.status.state, 'error');
    assert.equal(output.failures.length, 1);
  });
}

for (const key of ['REVIEW_DIFF_OUTCOME', 'EFFORT_OUTCOME', 'MODEL_OUTCOME']) {
  test(`${key} failure cannot become a clean review`, async () => {
    const output = await run({ result: { summary: '', findings: [] }, env: { [key]: 'failure' } });
    assert.equal(output.summary, undefined);
    assert.equal(output.status.state, 'error');
    assert.equal(output.failures.length, 1);
  });
}

for (const fail of ['createReview', 'createComment']) {
  test(`${fail} failure reports error and fails the job`, async () => {
    const output = await run({
      fail, result: fail === 'createComment' ? { summary: '', findings: [] } : result,
    });
    assert.equal(output.status.state, 'error');
    assert.equal(output.failures.length, 1);
    assert.equal(output.status.description, `Simulated ${fail} failure`);
    if (fail === 'createReview') {
      assert.equal(output.calls.some(call => ['createComment'].includes(call.method)), false);
    }
  });
}

test('cancelled Claude creates no progress, summary, or review comments', async () => {
  const output = await run({ isCodex: false, env: { MODEL_OUTCOME: 'cancelled' } });
  assert.deepEqual(output.calls.map(call => call.method), ['createCommitStatus']);
  assert.equal(output.status.state, 'error');
});

test('explicit success state still publishes threads and a green status', async () => {
  const output = await run({ env: { FINDINGS_STATE: 'success' } });
  assert.equal(output.review.comments.length, 1);
  assert.equal(output.status.state, 'success');
  assert.equal(output.failures.length, 0);
});

test('invalid findings_state fails rather than posting a misleading status', async () => {
  const output = await run({ env: { FINDINGS_STATE: 'pending' } });
  assert.equal(output.review, undefined);
  assert.equal(output.status.state, 'error');
  assert.equal(output.failures.length, 1);
});

for (const isCodex of [false, true]) {
  test(`${isCodex ? 'Codex' : 'Claude'} preserves the final result when review publication fails`, async () => {
    const output = await run({ isCodex, fail: 'createReview' });
    assert.equal(output.savedResult, isCodex ? jsonBlock(result) : JSON.stringify(result));
    assert.equal(output.status.state, 'error');
    assert.match(output.status.description, /createReview/);
  });
}

test('Claude preserves HTML entities from structured output without comment conversion', async () => {
  const original = { summary: 'エンティティ処理の不具合', findings: [{
    ...finding, body: '**引用符の扱い**\n入力 `&#34;` / `&#10;` / `&#96;` をそのまま扱ってください。',
  }] };
  const corrupted = JSON.stringify(original).replaceAll('&#34;', '"').replaceAll('&#10;', '\n');
  assert.throws(() => JSON.parse(corrupted));
  const output = await run({ isCodex: false, result: original });
  assert.ok(output.review.comments[0].body.startsWith(original.findings[0].body));
  assert.equal(output.savedResult, JSON.stringify(original));
  assert.equal(output.failures.length, 0);
});

for (const claudeReview of ['', '{', 'null', '{"summary":""}']) {
  test(`invalid structured Claude result ${JSON.stringify(claudeReview)} fails without fetching comment history`, async () => {
    const output = await run({ isCodex: false, claudeReview });
    assert.equal(output.review, undefined);
    assert.equal(output.status.state, 'error');
    assert.equal(output.failures.length, 1);
  });
}

for (const [key, description] of [
  ['REVIEW_DIFF_OUTCOME', 'PR差分を取得できませんでした'],
  ['EFFORT_OUTCOME', 'effort を決められませんでした'],
  ['MODEL_OUTCOME', 'レビューを完了できませんでした'],
]) {
  test(`${key} preserves its specific failure reason in the status`, async () => {
    const output = await run({ env: { [key]: 'failure' } });
    assert.equal(output.status.description, description);
  });
}

test('prepared diff stays aligned with PR head when base adds lines above the change', () => {
  assert.match(workflow, /uses: actions\/checkout@[^\n]+\n        with:\n(?:          #[^\n]*\n)*          ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  const tempDir = mkdtempSync(join(tmpdir(), 'pr-review-diff-test-'));
  const origin = join(tempDir, 'origin');
  const checkout = join(tempDir, 'checkout');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  try {
    git(tempDir, 'init', '-b', 'main', origin);
    const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    writeFileSync(join(origin, 'file.txt'), base);
    git(origin, 'add', 'file.txt');
    git(origin, 'commit', '-m', 'Initial file');
    git(origin, 'checkout', '-b', 'feature');
    writeFileSync(join(origin, 'file.txt'), base.replace('line 30\n', 'changed line\n'));
    git(origin, 'commit', '-am', 'PR change');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', 'main');
    writeFileSync(join(origin, 'file.txt'), `new base line\n${base}`);
    git(origin, 'commit', '-am', 'Base adds a line');
    git(origin, 'checkout', '-b', 'merge-result');
    git(origin, 'merge', '--no-edit', 'feature');
    const merged = git(origin, 'rev-parse', 'HEAD');
    git(tempDir, 'clone', origin, checkout);
    git(origin, 'checkout', 'feature');
    writeFileSync(join(origin, 'file.txt'), `future PR change\n${base}`);
    git(origin, 'commit', '-am', 'Later PR push');
    git(checkout, 'fetch', 'origin', 'feature');
    git(checkout, 'checkout', '--detach', head);
    assert.notEqual(git(checkout, 'rev-parse', 'origin/feature'), head);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
    assert.ok(!readFileSync(join(checkout, 'file.txt'), 'utf8').includes('future PR change'));
    const prepareScript = workflow.match(/      - name: Prepare PR diff\n[\s\S]*?        run: \|\n((?: {10}[^\n]*\n|\n)*)/)[1]
      .replace(/^ {10}/gm, '');
    execFileSync('bash', ['-c', prepareScript], {
      cwd: checkout, stdio: 'pipe', env: { ...process.env, BASE_REF: 'main', RUNNER_TEMP: tempDir },
    });
    const actual = readFileSync(join(tempDir, 'pr-review/pr.diff'), 'utf8').trim();
    assert.equal(actual, git(checkout, 'diff', `origin/main...${head}`));
    const changedLine = diff => {
      const hunk = diff.match(/@@ .* \+(\d+),(\d+) @@/);
      return Number(hunk[1]) + Number(hunk[2]) - 1;
    };
    assert.equal(changedLine(actual), 30);
    assert.equal(changedLine(git(checkout, 'diff', `origin/main...${merged}`)), 31);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude uses agent mode with only local read tools and no automatic comment history', () => {
  const claudeStep = workflow.split('      - name: Review with Claude\n')[1]
    .split('      - name: Set up Node.js for Codex')[0];
  assert.match(claudeStep, /track_progress: false/);
  assert.doesNotMatch(claudeStep, /include_comments_by_actor/);
  assert.match(claudeStep, /--tools "Read,Grep,Glob"/);
  assert.match(claudeStep, /--allowedTools "Read,Grep,Glob"/);
  assert.match(claudeStep, /--mcp-config '\{"mcpServers":\{\}\}'/);
  assert.match(claudeStep, /--strict-mcp-config/);
});
