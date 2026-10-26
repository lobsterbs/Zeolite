# Hybrid location rewriting (#456)

Status: **Partial**. The existing OXC pass already rewrites location reads,
uses a token pre-scan, skips inputs above 2 MiB and returns the source on parse
failure. It remains enabled by the existing rewriter configuration; this PR
does not switch working deployments to a new default-off policy.

Before adding the per-origin hybrid gate, assignment, update and delete
operands now use AST target spans. Prefix updates, parenthesized assignments,
destructuring and commented delete operands stay native. Genuine reads nested
inside computed write targets are still rewritten. Regression tests cover
these cases; byte peeks no longer decide whether a member is a write target.

Remaining #456 work: a reviewed default/migration policy, per-origin controls
consistent across inline and external scripts, bounded candidate buffering,
precise skipped/rewrite diagnostics, and direct/proxied compatibility fixtures.
A generic application 404 is not enough evidence to enable rewriting
automatically. Worker/eval and write virtualization remain separate stages.
