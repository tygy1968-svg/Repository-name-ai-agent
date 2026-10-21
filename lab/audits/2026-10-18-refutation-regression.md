# Lab finding: memory correction precedence (2026-10-18)

Source: archived CSV backup, read-only. Backup SHA-256: 770cb41f1a95c51a114a86aff24f4e43e83b8d6b8a6edccccd4e11ea8c9fdca0.

The backup contains 913 records across 12 tables. Three entries in memory are explicitly marked refuted (IDs 63, 131, 225). A subsequent interaction answered with the previously refuted brand. This is an observed memory retrieval failure.

Required invariant: a refuted claim must not be emitted as a verified fact. On conflicting records, abstain and surface the correction. Keep the original events immutable.

Next: implement a synthetic regression test in the lab branch, not in production.