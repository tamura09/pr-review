const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { test } = require('node:test');

// Execute the actual inline publisher. Reusable workflows check out the caller's
// repository, so the publisher cannot import a script from this repository.
const workflow = readFileSync(join(__dirname, '../workflows/pr-review.yml'), 'utf8');
const defaultFindingsState = workflow.match(/      findings_state:\n[\s\S]*?        default: "([^"]+)"/)[1];
const script = workflow.match(/- name: Publish review threads and status[\s\S]*?          script: \|\n((?: {12}[^\n]*\n|\n)*)/)[1].replace(/^ {12}/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publish = new AsyncFunction('github', 'context', 'core', 'process', 'require', script);
const restoreScript = workflow.match(/- name: Restore review result for publication retry[\s\S]*?          script: \|\n((?: {12}[^\n]*\n|\n)*)/)[1].replace(/^ {12}/gm, '');
const restore = new AsyncFunction('github', 'context', 'core', 'process', 'require', restoreScript);
const summaryReviews = server => server.reviews.filter(review => review.body?.includes('<!-- pr-review:summary:'));
const defaultDiff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -9 +9 @@
-old
+new
@@ -42 +42 @@
-old
+new
`;
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
  mkdirSync(join(tempDir, 'pr-review'));
  writeFileSync(join(tempDir, 'pr-review/pr.diff'), options.diff ?? defaultDiff);
  writeFileSync(join(tempDir, 'pr-review/files.z'), options.files ?? 'M\0src/example.ts\0');
  const env = {
    RUNNER_TEMP: tempDir,
    SHA: 'reviewed-head', RUN_URL: runUrl, FINDINGS_STATE: defaultFindingsState,
    REVIEWER: isCodex ? 'Codex · test-model · effort medium' : 'Claude · test-model · effort medium',
    IS_CODEX: String(isCodex), REVIEW_DIFF_OUTCOME: 'success',
    RESTORE_OUTCOME: 'success', RESTORED: 'false',
    EFFORT_OUTCOME: 'success', MODEL_OUTCOME: 'success', CODEX_REVIEW: raw,
    CLAUDE_REVIEW: options.claudeReview ?? JSON.stringify(options.result ?? result),
    ...options.env,
  };
  if (options.restoredRaw !== undefined) {
    mkdirSync(join(tempDir, 'pr-review-results'));
    writeFileSync(join(tempDir, 'pr-review-results', isCodex ? 'codex.md' : 'claude.json'), options.restoredRaw);
  }
  const server = options.server ?? { reviews: [], comments: [], nextId: 88 };
  server.issueComments ??= [];
  const fetches = [];
  const rejected = params => options.rejectLine || options.rejectLines?.includes(params.line);
  const api = method => async params => {
    calls.push({ method, params });
    if ((method === 'createReview' && params.comments.some(rejected)) ||
        (method === 'createReviewComment' && params.subject_type !== 'file' && rejected(params))) {
      const error = (method === 'createReview' ? options.batchPositionError : options.linePositionError) ??
        (method === 'createReview' ? { message: 'Unprocessable Entity: Line could not be resolved' } : {
          message: 'Validation Failed', response: { data: { message: 'Validation Failed', errors: [{
            resource: 'PullRequestReviewThread', field: 'line', code: 'custom',
            message: 'pull_request_review_thread.line must be part of the diff',
          }] } },
        });
      throw Object.assign(new Error(error.message), { status: 422 }, error);
    }
    const count = calls.filter(call => call.method === method).length;
    if (options.fail === method && (!options.failAt || options.failAt === count)) {
      throw Object.assign(new Error(options.failMessage ?? `Simulated ${method} failure`), { status: options.failStatus, response: options.failResponse });
    }
    const posted = { ...params, id: server.nextId++, user: { login: 'github-actions[bot]', type: 'Bot' } };
    if (method === 'createReview') {
      posted.state = 'COMMENTED';
      posted.html_url = `https://github.com/example/repo/pull/7#pullrequestreview-${posted.id}`;
      server.reviews.push(posted);
      for (const comment of params.comments) {
        const id = server.nextId++;
        server.comments.push({ ...comment, id, subject_type: 'line', user: posted.user, pull_request_review_id: posted.id,
          html_url: `https://github.com/example/repo/pull/7#discussion_r${id}` });
      }
    } else if (method === 'createReviewComment') {
      const id = server.nextId++;
      posted.pull_request_review_id = id;
      server.reviews.push({ id, state: 'COMMENTED', body: '', user: posted.user, commit_id: params.commit_id });
      posted.subject_type ??= 'line';
      posted.html_url = `https://github.com/example/repo/pull/7#discussion_r${posted.id}`;
      server.comments.push(posted);
    } else if (method === 'createComment') {
      posted.html_url = `https://github.com/example/repo/pull/7#issuecomment-${posted.id}`;
      server.issueComments.push(posted);
    } else if (method === 'updateReview') {
      server.reviews.find(review => review.id === params.review_id).body = params.body;
    }
    if (options.loseResponse === method) throw new Error(`Simulated ${method} response lost`);
    return { data: { ...posted } };
  };
  const github = {
    paginate: async (method, params) => {
      fetches.push({ method, params });
      if (options.fail === method) throw new Error(`Simulated ${method} failure`);
      const rows = method === 'listIssueComments' ? server.issueComments : method === 'listReviews' ? server.reviews : method === 'listCommentsForReview'
        ? server.comments.filter(comment => comment.pull_request_review_id === params.review_id) : server.comments;
      return structuredClone(rows);
    },
    rest: {
      pulls: { createReview: api('createReview'), createReviewComment: api('createReviewComment'),
        updateReview: api('updateReview'), listReviews: 'listReviews', listReviewComments: 'listReviewComments',
        listCommentsForReview: 'listCommentsForReview' },
      issues: { createComment: api('createComment'), listComments: 'listIssueComments' },
      repos: { createCommitStatus: api('createCommitStatus') },
    },
  };
  try {
    let thrown;
    try { await publish(github, {
      repo: { owner: 'example', repo: 'repo' }, payload: { pull_request: { number: 7 } },
    }, { error: message => errors.push(message), setFailed: message => failures.push(message) }, { env }, require); } catch (error) { thrown = error; }
    const resultPath = join(tempDir, 'pr-review-results', isCodex ? 'codex.md' : 'claude.json');
    return {
      artifactFiles: Object.fromEntries(['codex.md', 'claude.json', 'publication.json', 'pr.diff', 'files.z']
        .filter(name => existsSync(join(tempDir, 'pr-review-results', name)))
        .map(name => [name, readFileSync(join(tempDir, 'pr-review-results', name))])),
      savedResult: existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : undefined,
      publication: existsSync(join(tempDir, 'pr-review-results/publication.json'))
        ? JSON.parse(readFileSync(join(tempDir, 'pr-review-results/publication.json'), 'utf8')) : undefined,
      calls, failures, errors, server, fetches, thrown,
      review: calls.findLast(call => call.method === 'createReview')
        ? { ...calls.findLast(call => call.method === 'createReview').params,
            body: summaryReviews(server).at(-1)?.body ?? calls.findLast(call => call.method === 'createReview').params.body } : undefined,
      fileComments: calls.filter(call => call.method === 'createReviewComment' && call.params.subject_type === 'file').map(call => call.params),
      summary: summaryReviews(server).at(-1) ?? server.issueComments.at(-1),
      status: calls.find(call => call.method === 'createCommitStatus')?.params,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function recover(options = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'pr-review-restore-test-'));
  const source = join(tempDir, 'source');
  mkdirSync(source);
  const outputs = {}, calls = [];
  const env = { RUNNER_TEMP: tempDir, RUN_ATTEMPT: '2', SHA: 'reviewed-head', RUN_URL: runUrl,
    REVIEWER_KIND: 'codex', ...options.env };
  const artifactFiles = options.artifactFiles ?? {};
  let archive;
  if (Object.keys(artifactFiles).length) {
    for (const [name, bytes] of Object.entries(artifactFiles)) writeFileSync(join(source, name), bytes);
    const zip = join(tempDir, 'source.zip');
    execFileSync('zip', ['-q', zip, ...Object.keys(artifactFiles)], { cwd: source });
    archive = readFileSync(zip);
  }
  const github = {
    paginate: async (method, params) => {
      calls.push({ method, params });
      if (options.fail === method) throw new Error(`Simulated ${method} failure`);
      return method === 'listWorkflowRunArtifacts' ? (options.artifacts ?? [
        { id: 1, name: `pr-review-result-${env.REVIEWER_KIND}-1`, expired: false },
      ]) : method === 'listIssueComments' ? (options.issueComments ?? []) : (options.reviews ?? []);
    },
    rest: { actions: { listWorkflowRunArtifacts: 'listWorkflowRunArtifacts', downloadArtifact: async params => {
      calls.push({ method: 'downloadArtifact', params });
      if (options.fail === 'downloadArtifact') throw new Error('Simulated downloadArtifact failure');
      return { data: archive };
    } }, pulls: { listReviews: 'listReviews' }, issues: { listComments: 'listIssueComments' } },
  };
  let error;
  try {
    try {
      await restore(github, { repo: { owner: 'example', repo: 'repo' }, runId: 123,
        payload: { pull_request: { number: 7 } } },
      { setOutput: (key, value) => { outputs[key] = value; } }, { env }, require);
    } catch (failure) { error = failure; }
    const resultPath = join(tempDir, 'pr-review-results', env.REVIEWER_KIND === 'codex' ? 'codex.md' : 'claude.json');
    return { outputs, calls, error,
      raw: existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : undefined,
      diff: existsSync(join(tempDir, 'pr-review/pr.diff')) ? readFileSync(join(tempDir, 'pr-review/pr.diff'), 'utf8') : undefined,
      files: existsSync(join(tempDir, 'pr-review/files.z')) ? readFileSync(join(tempDir, 'pr-review/files.z'), 'utf8') : undefined,
      zipRemoved: !existsSync(join(tempDir, 'pr-review-results/retry.zip')) };
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
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

for (const isCodex of [false, true]) {
  test(`${isCodex ? 'Codex' : 'Claude'}: reproduce 213-line file with invalid lines 253, 282, and 291`, async () => {
    const script = 'scripts/lockfile_summary.py';
    const workflowPath = '.github/workflows/renovate.yml';
    const diff = `diff --git a/${script} b/${script}\nnew file mode 100644\n--- /dev/null\n+++ b/${script}\n@@ -0,0 +1,213 @@\n` +
      Array.from({ length: 213 }, (_, i) => `+line ${i + 1}\n`).join('') +
      `diff --git a/${workflowPath} b/${workflowPath}\n--- a/${workflowPath}\n+++ b/${workflowPath}\n@@ -265,3 +265,16 @@\n context\n context\n context\n` +
      Array.from({ length: 13 }, () => '+added\n').join('');
    const findings = [
      { ...finding, path: script, line: 282 },
      { ...finding, path: workflowPath, line: 279 },
      { ...finding, path: script, line: 291 },
      { ...finding, path: script, line: 253 },
    ];
    const output = await run({
      isCodex, diff, files: `A\0${script}\0M\0${workflowPath}\0`,
      result: { summary: '4 findings', findings },
    });
    assert.equal(output.failures.length, 0);
    assert.equal(output.status.state, 'failure');
    assert.equal(output.fileComments.length, 3);
    assert.equal(output.review.comments.length, 1);
    assert.equal(output.review.comments[0].line, 279);
    assert.equal(output.review.comments[0].path, workflowPath);
    for (const [i, comment] of output.fileComments.entries()) {
      assert.equal(comment.subject_type, 'file');
      assert.equal(comment.path, script);
      assert.equal(comment.commit_id, 'reviewed-head');
      assert.equal('line' in comment, false);
      assert.equal('side' in comment, false);
      assert.ok(comment.body.includes(`${[282, 291, 253][i]}行`));
    }
    assert.match(output.review.body, /指摘 4件/);
    assert.equal((output.review.body.match(/#discussion_r/g) || []).length, 3);
    assert.equal(output.calls.some(call => call.method === 'createComment'), false);
  });
}

test('existing lines outside the hunks are posted as file-level review threads', async () => {
  const output = await run({ result: { ...result, findings: [{ ...finding, line: 20 }] } });
  assert.equal(output.fileComments.length, 1);
  assert.equal(output.review.comments.length, 0);
  assert.equal(output.failures.length, 0);
});

test('context is valid on RIGHT and deletions only on LEFT', async () => {
  const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,3 +10,3 @@\n context\n-old\n+new\n tail\n';
  const findings = [
    { ...finding, line: 11, side: 'LEFT' },
    { ...finding, line: 11 },
    { ...finding, line: 10 },
    { ...finding, line: 10, side: 'LEFT' },
  ];
  const output = await run({ diff, result: { ...result, findings } });
  assert.deepEqual(output.review.comments.map(comment => [comment.side, comment.line]), [
    ['LEFT', 11], ['RIGHT', 11], ['RIGHT', 10],
  ]);
  assert.equal(output.fileComments.length, 1);
  assert.match(output.fileComments[0].body, /LEFT 10行/);
});

test('hunk content resembling patch headers does not change the file', async () => {
  const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n--- old\n-plain\n+++ new\n+plain\n';
  const output = await run({ diff, result: { ...result, findings: [{ ...finding, line: 1 }] } });
  assert.equal(output.review.comments[0].line, 1);
  assert.equal(output.fileComments.length, 0);
});

test('rename without textual changes falls back using the current path', async () => {
  const output = await run({
    files: 'R100\0old.ts\0new.ts\0',
    diff: 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
    result: { ...result, findings: [{ ...finding, path: 'old.ts', line: 1 }] },
  });
  assert.equal(output.fileComments[0].path, 'new.ts');
  assert.equal(output.failures.length, 0);
});

test('a GitHub position rejection retries each line and falls back only after individual rejection', async () => {
  const output = await run({ rejectLine: true });
  assert.equal(output.failures.length, 0);
  assert.equal(output.status.state, 'failure');
  assert.deepEqual(output.calls.map(call => call.method), [
    'createReview', 'createReview', 'createReviewComment', 'createReviewComment', 'updateReview', 'createCommitStatus',
  ]);
  assert.equal(output.review.comments.length, 0);
  assert.match(output.review.body, /#discussion_r/);
});

test('unrelated HTTP 422 errors are not retried as position failures', async () => {
  const output = await run({ fail: 'createReview', failStatus: 422, failMessage: 'Validation Failed: spammed' });
  assert.equal(output.fileComments.length, 0);
  assert.equal(output.status.state, 'error');
  assert.equal(output.failures.length, 1);
});

test('file-thread API failure remains an error and preserves the final result', async () => {
  const value = { ...result, findings: [{ ...finding, line: 999 }] };
  const output = await run({ fail: 'createReviewComment', result: value });
  assert.equal(output.review.comments.length, 0);
  assert.equal(output.status.state, 'error');
  assert.equal(output.savedResult, jsonBlock(value));
  assert.equal(output.publication.posted.length, 1);
  assert.match(output.errors[0], /pullrequestreview/);
});

test('unknown paths fail explicitly without attaching findings to an unrelated file', async () => {
  const output = await run({ result: { ...result, findings: [{ ...finding, path: 'not-in-pr.ts' }] } });
  assert.equal(output.fileComments.length, 0);
  assert.equal(output.review, undefined);
  assert.equal(output.status.state, 'error');
  assert.match(output.status.description, /not-in-pr\.ts/);
  assert.ok(output.savedResult);
});

test('summary failure publishes no file threads, including after a batch position rejection', async () => {
  const value = { ...result, findings: [finding, { ...finding, line: 999 }] };
  for (const rejectLine of [false, true]) {
    const output = await run({ result: value, rejectLine, fail: 'createReview', failAt: rejectLine ? 2 : 1 });
    assert.equal(output.server.comments.length, 0);
    assert.equal(summaryReviews(output.server).length, 0);
    assert.equal(output.fileComments.length, 0);
    assert.equal(output.status.state, 'error');
  }
});

test('one rejected position preserves other valid line threads and distinguishes the reason', async () => {
  const value = { ...result, findings: [finding, { ...finding, line: 9 }] };
  const output = await run({ result: value, rejectLines: [42] });
  assert.equal(output.failures.length, 0);
  assert.equal(summaryReviews(output.server).length, 1);
  assert.equal(output.server.comments.length, 2);
  assert.equal(output.fileComments.length, 1);
  assert.match(output.fileComments[0].body, /GitHub が行位置を拒否しました/);
  assert.doesNotMatch(output.fileComments[0].body, /差分内の行に紐付けられません/);
  assert.equal(output.server.comments.find(comment => comment.subject_type === 'line').line, 9);
  assert.match(output.summary.body, /指摘 2件/);
});

test('partial file publication is logged and resumes without duplicate summaries or threads', async () => {
  const value = { ...result, findings: [finding, { ...finding, line: 998 }, { ...finding, line: 999 }] };
  const first = await run({ result: value, fail: 'createReviewComment', failAt: 2 });
  assert.equal(first.status.state, 'error');
  assert.equal(summaryReviews(first.server).length, 1);
  assert.equal(first.server.comments.length, 2);
  assert.equal(first.publication.posted.length, 3);
  assert.match(first.publication.posted[0].url, /pullrequestreview/);
  assert.match(first.publication.posted[1].url, /discussion_r/);
  assert.equal(first.publication.error, 'Simulated createReviewComment failure');
  assert.ok(first.errors.some(message => message.includes(first.publication.posted[1].url)));

  const resumed = await run({ result: value, server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(resumed.status.state, 'failure');
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.server.comments.length, 3);
  assert.equal(resumed.calls.filter(call => call.method === 'createReview').length, 0);
  assert.equal(resumed.fileComments.length, 1);
  assert.equal(resumed.publication.complete, true);
  assert.equal((resumed.summary.body.match(/#discussion_r/g) || []).length, 2);
});

test('a failed summary link update is repaired without reposting the published file thread', async () => {
  const value = { ...result, findings: [{ ...finding, line: 999 }] };
  const first = await run({ result: value, fail: 'updateReview' });
  assert.equal(first.status.state, 'error');
  assert.equal(first.server.comments.length, 1);
  assert.equal(first.publication.posted.length, 2);
  const resumed = await run({ result: value, server: first.server });
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.server.comments.length, 1);
  assert.equal(resumed.fileComments.length, 0);
  assert.equal(resumed.failures.length, 0);
  assert.match(resumed.summary.body, /#discussion_r/);
});

test('a partial individual line retry reuses the valid thread on the next attempt', async () => {
  const value = { ...result, findings: [{ ...finding, line: 9 }, finding] };
  const first = await run({ result: value, rejectLines: [42], fail: 'createReviewComment', failAt: 3 });
  assert.equal(first.status.state, 'error');
  assert.equal(first.server.comments.length, 1);
  assert.equal(first.server.comments[0].line, 9);
  const resumed = await run({ result: value, rejectLines: [42], server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.server.comments.length, 2);
  assert.equal(resumed.fileComments.length, 1);
  assert.equal(resumed.server.comments.filter(comment => comment.subject_type === 'line').length, 1);
});

test('a completed retry creates no new threads even if an existing one was resolved', async () => {
  const first = await run();
  first.server.comments[0].is_resolved = true;
  const resumed = await run({ server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(resumed.server.comments.length, 1);
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.status.state, 'failure');
  assert.deepEqual(resumed.calls.map(call => call.method), ['updateReview', 'createCommitStatus']);
});

for (const method of ['createReview', 'createReviewComment']) {
  test(`${method} response loss is recovered from GitHub without duplicate threads`, async () => {
    const value = { ...result, findings: [{ ...finding, line: 999 }] };
    const first = await run({ result: value, loseResponse: method });
    assert.equal(first.status.state, 'error');
    const resumed = await run({ result: value, server: first.server });
    assert.equal(resumed.failures.length, 0);
    assert.equal(summaryReviews(resumed.server).length, 1);
    assert.equal(resumed.server.comments.length, 1);
    assert.match(resumed.summary.body, /#discussion_r/);
  });
}

test('changed model results create a separate summary and preserve the previous count and links', async () => {
  const original = { summary: 'Original three findings', findings: [finding,
    { ...finding, line: 998 }, { ...finding, line: 999 }] };
  const first = await run({ result: original, fail: 'createReviewComment', failAt: 2 });
  assert.equal(first.status.state, 'error');
  const previousBody = first.server.reviews[0].body;
  const changed = { summary: 'New two findings', findings: [finding, { ...finding, line: 9 }] };
  const resumed = await run({ result: changed, server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(summaryReviews(resumed.server).length, 2);
  assert.equal(resumed.server.comments.length, 4);
  assert.equal(resumed.server.reviews[0].body, previousBody);
  assert.match(previousBody, /指摘 3件/);
  assert.match(previousBody, /#discussion_r/);
  assert.match(resumed.summary.body, /指摘 2件/);
  assert.notEqual(first.publication.result_key, resumed.publication.result_key);
});

test('identical results with different JSON field order still reuse the publication', async () => {
  const first = await run();
  const reordered = { findings: [{ body: finding.body, side: finding.side, line: finding.line, path: finding.path }],
    summary: result.summary };
  const resumed = await run({ result: reordered, server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.server.comments.length, 1);
  assert.equal(first.publication.result_key, resumed.publication.result_key);
});

for (const user of [{ login: 'mallory', type: 'User' }, { login: 'another[bot]', type: 'Bot' },
  { login: 'github-actions[bot]', type: 'User' }, undefined]) {
  test(`copied publication markers from ${JSON.stringify(user)} cannot impersonate the publisher`, async () => {
    const seed = await run();
    const server = structuredClone(seed.server);
    server.reviews[0].user = user;
    server.reviews[0].body = 'Copied review\n' + server.reviews[0].body;
    server.comments[0].user = user;
    const forgedBody = server.reviews[0].body;
    const output = await run({ server });
    assert.equal(output.failures.length, 0);
    assert.equal(summaryReviews(output.server).length, 2);
    assert.equal(output.server.comments.length, 2);
    assert.equal(output.server.reviews[0].body, forgedBody);
    assert.ok(output.publication.posted.every(item => item.id !== server.reviews[0].id && item.id !== server.comments[0].id));
  });
}

for (const message of ['Pull request review thread line must be part of the diff',
  'pull_request_review_thread.line must be part of the diff']) {
  test(`both endpoints fall back for position message: ${message}`, async () => {
    const output = await run({ rejectLine: true,
      batchPositionError: { message }, linePositionError: { message } });
    assert.equal(output.failures.length, 0);
    assert.equal(output.fileComments.length, 1);
    assert.equal(output.status.state, 'failure');
  });
}

test('structured line errors are recognized when the field and message are separate', async () => {
  const error = { message: 'Validation Failed', response: { data: { errors: [{
    resource: 'PullRequestReviewThread', field: 'line', code: 'custom', message: 'must be part of the diff',
  }] } } };
  const output = await run({ rejectLine: true, batchPositionError: error, linePositionError: error });
  assert.equal(output.failures.length, 0);
  assert.equal(output.fileComments.length, 1);
});

for (const error of [
  { status: 500, message: 'Pull request review thread line must be part of the diff' },
  { message: 'Validation Failed', response: { data: { errors: [{ field: 'line', message: 'is invalid' }] } } },
  { message: 'Validation Failed', response: { data: { errors: [{ field: 'body', message: 'must be part of the diff' }] } } },
]) {
  test(`unrelated individual API error is preserved: ${JSON.stringify(error)}`, async () => {
    const output = await run({ rejectLine: true, linePositionError: error });
    assert.equal(output.failures.length, 1);
    assert.equal(output.fileComments.length, 0);
    assert.equal(output.status.state, 'error');
  });
}

test('batch thread URLs are recorded before any subsequent file-thread failure', async () => {
  const value = { ...result, findings: [finding, { ...finding, line: 9 }, { ...finding, line: 999 }] };
  const output = await run({ result: value, fail: 'createReviewComment' });
  assert.equal(output.status.state, 'error');
  assert.equal(output.server.comments.length, 2);
  const recorded = output.publication.posted.filter(item => item.kind === 'comment');
  assert.equal(recorded.length, 2);
  for (const comment of output.server.comments) {
    assert.ok(recorded.some(item => item.id === comment.id && item.url === comment.html_url));
    assert.ok(output.errors.some(message => message.includes(comment.html_url)));
  }
  assert.ok(output.fetches.some(fetch => fetch.method === 'listCommentsForReview' && fetch.params.review_id === output.summary.id));
});

test('failure to fetch batch thread URLs stops additional publication and recovers on retry', async () => {
  const value = { ...result, findings: [finding, { ...finding, line: 999 }] };
  const first = await run({ result: value, fail: 'listCommentsForReview' });
  assert.equal(first.status.state, 'error');
  assert.equal(first.server.comments.length, 1);
  assert.equal(first.fileComments.length, 0);
  assert.equal(first.publication.posted.length, 1);
  const resumed = await run({ result: value, server: first.server });
  assert.equal(resumed.failures.length, 0);
  assert.equal(summaryReviews(resumed.server).length, 1);
  assert.equal(resumed.server.comments.length, 2);
  assert.equal(resumed.publication.posted.filter(item => item.kind === 'comment').length, 2);
});

test('publication identities do not collide across reviewers, heads, or workflow runs', async () => {
  for (const options of [{ isCodex: false }, { env: { SHA: 'another-head' } }, { env: { RUN_URL: runUrl + '4' } }]) {
    const first = await run();
    const second = await run({ ...options, server: first.server });
    assert.equal(second.failures.length, 0);
    assert.equal(summaryReviews(second.server).length, 2);
    assert.equal(second.server.comments.length, 2);
  }
});

for (const method of ['listReviews', 'listReviewComments']) {
  test(`${method} failure cannot publish duplicate threads without reading the previous attempt`, async () => {
    const output = await run({ fail: method });
    assert.equal(output.status.state, 'error');
    assert.equal(output.server.comments.length, 0);
    assert.equal(summaryReviews(output.server).length, 0);
    assert.equal(output.fetches.length, 2);
    assert.ok(output.fetches.every(fetch => fetch.params.per_page === 100));
  });
}

test('first attempt does not query artifacts or reviews', async () => {
  const output = await recover({ env: { RUN_ATTEMPT: '1' } });
  assert.equal(output.error, undefined);
  assert.equal(output.outputs.restored, 'false');
  assert.equal(output.calls.length, 0);
});

for (const isCodex of [false, true]) {
  test(`${isCodex ? 'Codex' : 'Claude'}: restore a failed publication and resume without a new model result`, async () => {
    const value = { summary: 'Original result', findings: [finding, { ...finding, line: 998 }, { ...finding, line: 999 }] };
    const first = await run({ isCodex, result: value, fail: 'createReviewComment', failAt: 2 });
    const recovered = await recover({ artifactFiles: first.artifactFiles,
      env: { REVIEWER_KIND: isCodex ? 'codex' : 'claude' } });
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.outputs.restored, 'true');
    assert.equal(recovered.raw, first.savedResult);
    assert.equal(recovered.diff, defaultDiff);
    assert.equal(recovered.zipRemoved, true);
    const resumed = await run({ isCodex, server: first.server,
      result: { summary: 'Changed model output must not be used', findings: [] },
      restoredRaw: recovered.raw, diff: recovered.diff, files: recovered.files,
      env: { RESTORED: 'true', REVIEW_DIFF_OUTCOME: 'skipped', EFFORT_OUTCOME: 'skipped', MODEL_OUTCOME: 'skipped',
        REVIEWER: recovered.outputs.reviewer } });
    assert.equal(resumed.failures.length, 0);
    assert.equal(resumed.status.state, 'failure');
    assert.equal(summaryReviews(resumed.server).length, 1);
    assert.equal(resumed.server.comments.length, 3);
    assert.equal(resumed.fileComments.length, 1);
    assert.match(resumed.summary.body, /指摘 3件.*Original result/);
    assert.equal(resumed.savedResult, first.savedResult);
    assert.equal(resumed.publication.result_key, first.publication.result_key);
  });
}

test('restore selects the latest previous attempt for its reviewer only', async () => {
  const first = await run({ fail: 'createReview' });
  const output = await recover({ artifactFiles: first.artifactFiles, env: { RUN_ATTEMPT: '4' }, artifacts: [
    { id: 1, name: 'pr-review-result-codex-1' }, { id: 2, name: 'pr-review-result-codex-3' },
    { id: 3, name: 'pr-review-result-claude-3' }, { id: 4, name: 'pr-review-result-codex-4' },
    { id: 5, name: 'pr-review-result-codex-nope' },
  ] });
  assert.equal(output.error, undefined);
  assert.equal(output.calls.find(call => call.method === 'downloadArtifact').params.artifact_id, 2);
});

for (const change of [{ sha: 'wrong-head' }, { run_url: runUrl + '4' }, { reviewer: 'claude-review' }, { model_label: null }]) {
  test(`mismatched artifact metadata stops restoration: ${JSON.stringify(change)}`, async () => {
    const first = await run({ fail: 'createReview' });
    first.artifactFiles['publication.json'] = Buffer.from(JSON.stringify({ ...first.publication, ...change }));
    const output = await recover({ artifactFiles: first.artifactFiles });
    assert.match(output.error.message, /一致しません/);
    assert.equal(output.outputs.restored, 'false');
    assert.equal(output.zipRemoved, true);
  });
}

test('expired or inaccessible artifacts fail instead of silently invoking the model again', async () => {
  const expired = await recover({ artifacts: [{ id: 1, name: 'pr-review-result-codex-1', expired: true }] });
  assert.match(expired.error.message, /期限切れ/);
  for (const fail of ['listWorkflowRunArtifacts', 'downloadArtifact']) {
    const output = await recover({ fail });
    assert.match(output.error.message, /Simulated/);
    assert.equal(output.outputs.restored, 'false');
  }
  const published = await run({ env: { RESTORE_OUTCOME: 'failure' } });
  assert.equal(published.status.state, 'error');
  assert.equal(published.server.reviews.length, 0);
  assert.match(published.status.description, /復元できません/);
});

test('missing artifacts allow model execution only when this reviewer has not published a summary', async () => {
  const clean = await recover({ artifacts: [] });
  assert.equal(clean.error, undefined);
  assert.equal(clean.outputs.restored, 'false');
  const first = await run();
  const posted = await recover({ artifacts: [], reviews: first.server.reviews });
  assert.match(posted.error.message, /保存結果がありません/);
  const other = await run({ isCodex: false });
  const otherReviewer = await recover({ artifacts: [], reviews: other.server.reviews });
  assert.equal(otherReviewer.error, undefined);
});

test('missing snapshot data fails restoration instead of regenerating a different diff', async () => {
  const first = await run({ fail: 'createReview' });
  delete first.artifactFiles['pr.diff'];
  const output = await recover({ artifactFiles: first.artifactFiles });
  assert.ok(output.error);
  assert.equal(output.outputs.restored, 'false');
  assert.equal(output.diff, undefined);
  assert.equal(output.zipRemoved, true);
});

test('restored results skip diff preparation, token lookup, and both model paths', () => {
  const section = name => workflow.slice(workflow.indexOf(`      - name: ${name}`)).split(/\n      - name: /)[0];
  assert.match(section('Prepare PR diff'), /steps.restore_review.outputs.restored != 'true'/);
  assert.match(section('Decide where the token comes from'), /steps.restore_review.outputs.restored != 'true'/);
  assert.match(section('Decide review effort'), /steps.review_diff.outcome == 'success'/);
  for (const name of ['Review with Claude', 'Review with Codex']) {
    assert.match(section(name), /steps.restore_review.outputs.restored != 'true'/);
  }
  assert.match(section('Report PR diff preparation failure'), /steps.restore_review.outputs.restored != 'true'/);
  for (const filename of ['../workflows/pr-review.yml', '../workflows/self-review.yml', '../../examples/pr-review.yml']) {
    assert.match(readFileSync(join(__dirname, filename), 'utf8'), /  actions: read/);
  }
});

test('individual comment API creates additional COMMENTED reviews with no separate summary body', async () => {
  const output = await run({ rejectLine: true, result: { ...result, findings: [finding, { ...finding, line: 9 }] } });
  assert.equal(output.failures.length, 0);
  assert.equal(summaryReviews(output.server).length, 1);
  assert.equal(output.server.reviews.length, 3);
  for (const comment of output.server.comments) {
    const review = output.server.reviews.find(item => item.id === comment.pull_request_review_id);
    assert.equal(review.state, 'COMMENTED');
    assert.equal(review.body, '');
    assert.notEqual(review.id, output.summary.id);
  }
});

for (const isCodex of [false, true]) {
  for (const mode of ['createCommitStatus', 'createComment']) {
    test(`${isCodex ? 'Codex' : 'Claude'}: no-findings publication recovers after ${mode} without another comment`, async () => {
      const value = { summary: '', findings: [] };
      const first = await run({ isCodex, result: value,
        ...(mode === 'createCommitStatus' ? { fail: mode } : { loseResponse: mode }) });
      if (mode === 'createCommitStatus') assert.match(first.thrown.message, /createCommitStatus/);
      else assert.equal(first.failures.length, 1);
      assert.equal(first.server.issueComments.length, 1);
      const recovered = await recover({ artifactFiles: first.artifactFiles,
        env: { REVIEWER_KIND: isCodex ? 'codex' : 'claude' } });
      assert.equal(recovered.error, undefined);
      assert.equal(recovered.outputs.restored, 'true');
      const resumed = await run({ isCodex, server: first.server, restoredRaw: recovered.raw,
        env: { RESTORED: 'true', REVIEW_DIFF_OUTCOME: 'skipped', EFFORT_OUTCOME: 'skipped', MODEL_OUTCOME: 'skipped' } });
      assert.equal(resumed.thrown, undefined);
      assert.equal(resumed.failures.length, 0);
      assert.equal(resumed.status.state, 'success');
      assert.equal(resumed.server.issueComments.length, 1);
      assert.equal(resumed.calls.some(call => call.method === 'createComment'), false);
      assert.deepEqual(resumed.publication.posted, [{ kind: 'summary',
        id: first.server.issueComments[0].id, url: first.server.issueComments[0].html_url }]);
    });
  }
}

test('copied no-findings markers from another author are not reused', async () => {
  const value = { summary: '', findings: [] };
  const first = await run({ result: value });
  first.server.issueComments[0].user = { login: 'mallory', type: 'User' };
  const next = await run({ result: value, server: first.server });
  assert.equal(next.failures.length, 0);
  assert.equal(next.server.issueComments.length, 2);
  assert.equal(next.publication.posted[0].id, next.server.issueComments[1].id);
});

test('missing artifact detection includes no-findings comments and is scoped to the head', async () => {
  const first = await run({ result: { summary: '', findings: [] } });
  const output = await recover({ artifacts: [], issueComments: first.server.issueComments });
  assert.match(output.error.message, /保存結果がありません/);
  const otherHead = await recover({ artifacts: [], issueComments: first.server.issueComments, env: { SHA: 'another-head' } });
  assert.equal(otherHead.error, undefined);
  const otherReviewer = await recover({ artifacts: [], issueComments: first.server.issueComments, env: { REVIEWER_KIND: 'claude' } });
  assert.equal(otherReviewer.error, undefined);
});

for (const findings of [[finding], []]) {
  test(`successful result with ${findings.length} findings is retained and survives rerunning all jobs`, async () => {
    const first = await run({ result: { summary: '', findings } });
    assert.equal(first.publication.complete, true);
    assert.equal(first.publication.restorable, true);
    const recovered = await recover({ artifactFiles: first.artifactFiles });
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.outputs.restored, 'true');
    const next = await run({ server: first.server, restoredRaw: recovered.raw,
      env: { RESTORED: 'true', REVIEW_DIFF_OUTCOME: 'skipped', EFFORT_OUTCOME: 'skipped', MODEL_OUTCOME: 'skipped' } });
    assert.equal(next.failures.length, 0);
    assert.equal(next.status.state, first.status.state);
    assert.equal(next.server.comments.length, findings.length);
    assert.equal(next.server.issueComments.length, findings.length ? 0 : 1);
  });
}

for (const options of [{ raw: 'not JSON' },
  { result: { summary: '', findings: [{ ...finding, path: 'missing.ts' }] } },
  { result: { summary: '', findings: [{ ...finding, line: 0 }] } }]) {
  test(`validation failure permits a new model result on the same run: ${JSON.stringify(options)}`, async () => {
    const first = await run(options);
    assert.equal(first.status.state, 'error');
    assert.equal(first.publication.restorable, false);
    assert.equal(first.publication.posted.length, 0);
    const recovered = await recover({ artifactFiles: first.artifactFiles });
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.outputs.restored, 'false');
    assert.equal(recovered.raw, undefined);
    const next = await run({ result, server: first.server });
    assert.equal(next.failures.length, 0);
    assert.equal(next.status.state, 'failure');
    assert.equal(next.server.comments.length, 1);
  });
}

test('an invalid result marked as already posted cannot silently invoke the model again', async () => {
  const first = await run();
  first.artifactFiles['publication.json'] = Buffer.from(JSON.stringify({ ...first.publication, restorable: false }));
  const recovered = await recover({ artifactFiles: first.artifactFiles });
  assert.match(recovered.error.message, /判定できません/);
  assert.equal(recovered.outputs.restored, 'false');
});

test('artifact upload runs after successful publication as well as failed publication', () => {
  const section = workflow.slice(workflow.indexOf('      - name: Preserve review result and publication state'));
  assert.match(section, /always\(\) && steps.publish_review.outcome != 'skipped'/);
  assert.doesNotMatch(section, /steps.publish_review.outcome == 'failure'/);
});

test('real Git patches preserve quoted paths, renames, deleted files, and binary files', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'pr-review-path-test-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: tempDir, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  try {
    git('init', '-b', 'main');
    const original = Array.from({ length: 100 }, (_, i) => `line ${i + 1}\n`).join('');
    writeFileSync(join(tempDir, 'old.txt'), original);
    writeFileSync(join(tempDir, 'removed.txt'), 'removed\n');
    git('add', '.');
    git('commit', '-m', 'Initial files');
    git('mv', 'old.txt', 'new.txt');
    writeFileSync(join(tempDir, 'new.txt'), original.replace('line 100\n', 'changed\n'));
    git('rm', 'removed.txt');
    const names = ['with space.txt', 'tab\tname.txt', 'quote"name.txt', 'back\\slash.txt', '日本語.txt', 'new\nline.txt'];
    for (const name of names) writeFileSync(join(tempDir, name), 'added\n');
    writeFileSync(join(tempDir, 'binary.bin'), Buffer.from([0, 1, 0]));
    git('add', '.');
    const diff = git('diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/');
    const files = git('diff', '--cached', '--name-status', '-z', '--find-renames');
    const findings = [
      ...names.map(path => ({ ...finding, path, line: 1 })),
      { ...finding, path: 'old.txt', line: 100, side: 'LEFT' },
      { ...finding, path: 'removed.txt', line: 1, side: 'LEFT' },
      { ...finding, path: 'binary.bin', line: 1 },
    ];
    const output = await run({ diff, files, result: { ...result, findings } });
    assert.equal(output.failures.length, 0);
    assert.equal(output.review.comments.length, names.length + 2);
    assert.deepEqual(output.review.comments.slice(0, names.length).map(c => c.path), names);
    assert.equal(output.review.comments[names.length].path, 'new.txt');
    assert.equal(output.review.comments[names.length + 1].path, 'removed.txt');
    assert.equal(output.fileComments.length, 1);
    assert.equal(output.fileComments[0].path, 'binary.bin');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
