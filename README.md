# bazel-r2-cache

A Bazel HTTP remote cache served by a Cloudflare Worker over R2, shared by the tbhb-dev repositories.

## Getting started

```sh
mise install
bazelisk run //:bazel_env
tbhbdev alpha install
bazelisk test //...
```

`bazelisk test //...` runs every lint, audit, and test gate. The documentation is in [docs/](docs/index.md).

## Using the cache in CI

A repository's Bazel job calls `.github/actions/remote-cache`, pinned by commit, and passes both tokens. The action picks one by the event:

| Event | Token | Pull request header |
| --- | --- | --- |
| Push to `main`, or `merge_group` | The repository's main token | None |
| `pull_request` | The org's PR token | `owner/repo/number` |
| Anything else | None: the job builds without the cache | None |

```yaml
- uses: tbhb-dev/bazel-r2-cache/.github/actions/remote-cache@<commit>
  with:
    main-token: ${{ secrets.BAZEL_CACHE_TOKEN }}
    pr-token: ${{ secrets.BAZEL_CACHE_PR_TOKEN }}
```

The action also caps how long one cache call can stall a build. It writes `common:ci --remote_timeout` and `--remote_retries` lines to `~/.bazelrc`, which Bazel reads after the repository's rc files, so they override the preset's `--remote_timeout=3600` under `--config=ci`. A plain `common` line would lose, because `--config=ci` expands after it. The defaults are 120 seconds and 3 retries; pass `remote-timeout` or `remote-retries` (whole numbers) only to change them. Bazel applies the timeout to each HTTP read and write, not to a whole transfer, so a large upload on a slow link still finishes as long as bytes keep moving. A call that stalls fails after 120 seconds. `--remote_local_fallback` covers remote execution, not HTTP cache failures: a failed cache read counts as a miss and a failed upload only logs a warning. With `--remote_timeout=120` and `--remote_retries=3`, a stalled lookup can take up to about 480 seconds plus backoff before it gives up.

The Worker binds a token from its `REPO_MAIN_TOKENS` mapping to the repository's `ac/main/<owner>/<repo>/` namespace, so pass that token and not the legacy shared main token. A merge queue run then writes the same entries a push to `main` would.

A read or host token can read a repository's main action cache by setting `--remote_header=Bazel-Cache-Repository=owner/repo` in `~/.bazelrc`. The Worker looks up that repository's entries before the shared main entries. Hosts never write to a repository's main action cache.

A merge queue run builds code that no push to `main` has reviewed yet, and it writes with the main token. A repository that adopts a merge queue must therefore require approval, with stale-review dismissal, before a pull request can be queued. Without that, a change nobody approved could write main entries.

The main token is a secret of the main-only `cache` environment. A job that reads it on a merge queue run needs `environment: cache`, and the environment's deployment branch rules must allow the queue's `gh-readonly-queue/main/*` refs, or GitHub refuses the job.
