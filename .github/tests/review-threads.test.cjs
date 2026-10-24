const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

// Execute the actual inline publisher. Reusable workflows check out the caller's
// repository, so the publisher cannot import a script from this repository.
const workflow = readFileSync(join(__dirname, '../workflows/pr-review.yml'), 'utf8');
const script = workflow.split('          script: |\n').at(-1)
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publish = new AsyncFunction('github', 'context', 'core', 'process', script);
const runUrl = 'https://github.com/example/repo/actions/runs/123';
const finding = {
  path: 'src/example.ts', line: 42, side: 'RIGHT',
  body: '**境界値で失敗する**\n入力が 0 の場合に例外になるため、境界条件を修正してください。',
};
const result = { summary: '境界値で失敗する', findings: [finding] };
const jsonBlock = value => '```json\n' + JSON.stringify(value) + '\n```';
const comment = (id, body, login = 'github-actions[bot]') => ({ id, body, user: { login } });

async function run(options = {}) {
  const isCodex = options.isCodex ?? true;
  const raw = options.raw ?? jsonBlock(options.result ?? result);
  const calls = [];
  const failures = [];
  const errors = [];
  const env = {
    SHA: 'reviewed-head', RUN_URL: runUrl, FINDINGS_STATE: 'success',
    REVIEWER: isCodex ? 'Codex · test-model · effort medium' : 'Claude · test-model · effort medium',
    IS_CODEX: String(isCodex), REVIEW_DIFF_OUTCOME: 'success',
    EFFORT_OUTCOME: 'success', MODEL_OUTCOME: 'success', CODEX_REVIEW: raw,
    ...options.env,
  };
  const api = method => async params => {
    calls.push({ method, params });
    if (options.fail === method) throw new Error(`Simulated ${method} failure`);
    return { data: { id: 88, html_url: 'https://github.com/example/repo/pull/7#pullrequestreview-88' } };
  };
  const github = {
    paginate: async (method, params) => {
      calls.push({ method: 'listComments', params });
      return options.sourceComments ?? [comment(1, `${raw}\n\n${runUrl}`)];
    },
    rest: {
      pulls: { createReview: api('createReview') },
      issues: {
        listComments: () => {},
        createComment: api('createComment'), updateComment: api('updateComment'),
      },
      repos: { createCommitStatus: api('createCommitStatus') },
    },
  };
  await publish(github, {
    repo: { owner: 'example', repo: 'repo' }, payload: { pull_request: { number: 7 } },
  }, { error: message => errors.push(message), setFailed: message => failures.push(message) }, { env });
  return {
    calls, failures, errors,
    review: calls.find(call => call.method === 'createReview')?.params,
    summary: calls.find(call => ['createComment', 'updateComment'].includes(call.method))?.params,
    status: calls.find(call => call.method === 'createCommitStatus')?.params,
  };
}

for (const isCodex of [false, true]) {
  const reviewer = isCodex ? 'Codex' : 'Claude';
  test(`${reviewer}: one resolvable thread per finding, then a count-only summary`, async () => {
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
    assert.ok(output.summary.body.includes('#pullrequestreview-88'));
    assert.ok(!output.summary.body.includes('入力が 0'));
    assert.ok(!output.summary.body.includes('```json'));
    assert.equal(output.summary.body.startsWith('<!-- pr-review:codex -->'), isCodex);
    assert.equal(output.status.state, 'success');
    assert.equal(output.status.context, isCodex ? 'codex-review' : 'claude-review');
    assert.equal(output.status.sha, 'reviewed-head');
    assert.match(output.status.description, /^指摘 2件/);
    assert.deepEqual(output.calls.slice(-3).map(call => call.method), [
      'createReview', isCodex ? 'createComment' : 'updateComment', 'createCommitStatus',
    ]);
  });

  test(`${reviewer}: no findings creates no threads and removes model commentary`, async () => {
    const raw = `確認しました\n${jsonBlock({ summary: '確認結果は表示しない', findings: [] })}\n追加の指摘はありません`;
    const output = await run({ isCodex, raw });
    assert.equal(output.review, undefined);
    assert.ok(output.summary.body.includes('**✅ 指摘なし**'));
    assert.ok(!output.summary.body.includes('確認'));
    assert.ok(!output.summary.body.includes('追加の指摘'));
    assert.equal(output.status.state, 'success');
    assert.equal(output.status.description, '指摘なし');
    assert.equal(output.failures.length, 0);
  });
}

test('Claude uses only its own bot comment from this run', async () => {
  const raw = jsonBlock(result);
  const output = await run({
    isCodex: false,
    sourceComments: [
      comment(1, `${raw}\n${runUrl.replace('/123', '/12')}`),
      comment(2, `${raw}\n${runUrl}`),
      comment(3, `${raw}\n${runUrl}`, 'attacker'),
      comment(4, `<!-- pr-review:codex -->\n${raw}\n${runUrl}`),
    ],
  });
  assert.equal(output.summary.comment_id, 2);
  assert.equal(output.status.state, 'success');
});

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

test('missing Claude source comment is an error', async () => {
  const output = await run({ isCodex: false, sourceComments: [] });
  assert.equal(output.status.state, 'error');
  assert.equal(output.summary, undefined);
});

for (const fail of ['createReview', 'createComment', 'updateComment']) {
  test(`${fail} failure reports error and fails the job`, async () => {
    const output = await run({ fail, isCodex: fail !== 'updateComment' });
    assert.equal(output.status.state, 'error');
    assert.equal(output.failures.length, 1);
    if (fail === 'createReview') assert.equal(output.summary, undefined);
  });
}

test('explicit legacy failure state still publishes threads and a red status', async () => {
  const output = await run({ env: { FINDINGS_STATE: 'failure' } });
  assert.equal(output.review.comments.length, 1);
  assert.equal(output.status.state, 'failure');
  assert.equal(output.failures.length, 0);
});

test('invalid findings_state fails rather than posting a misleading status', async () => {
  const output = await run({ env: { FINDINGS_STATE: 'pending' } });
  assert.equal(output.review, undefined);
  assert.equal(output.status.state, 'error');
  assert.equal(output.failures.length, 1);
});
