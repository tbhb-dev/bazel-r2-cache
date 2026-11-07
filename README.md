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
