# Continuity integration map — 2026-10-19

This branch starts from `kuzya-memory-lab-20261017` at commit `59ee7b6b459b362a6c97b51470b214e03b6c4316`.

It is the integration branch. Production `main` is not modified.

## What already exists

The memory-lab branch is not empty or primitive. It already contains:

- memory-forensics and refutation-regression audits;
- fact-ingestion root-cause analysis;
- unified-channel baseline;
- an append-only decision ledger and portable snapshots;
- contradiction/refutation evaluators;
- fact-candidate policy and memory-claim resolution;
- tests and CI.

Therefore new continuity work should extend this branch rather than build a second parallel memory system.

## Current production shape

Production `main` contains only `agent.js`, `server.js`, and `package.json`. The two JS entrypoints are large and mix transport, memory, continuity, prompting, persistence, and channel logic. This is the main structural debt.

Known production risks already documented by the lab:

1. fact extraction can write a candidate as an active long-term fact before reply generation;
2. Telegram memory and cross-channel interaction logging use inconsistent user identifiers;
3. self-review/evolution text can be mistaken for evidence that a functional transition occurred;
4. historical records, interpretations, and future behavioral constraints are not represented as separate causal layers.

## Integration invariant

```
Evidence != Interpretation != Consequence
```

A later event is required to verify a claimed transition.

```
event(t)
  -> candidate transition
  -> predicted consequence
  -> later opportunity(t+n)
  -> observed behavior
  -> supports | contradicts | neutral
```

The event that proposes a rule cannot verify that same rule.

## One ledger, not two

The existing append-only `kuzya_decision_ledger_lab` remains the historical backbone.

Do not create a competing production continuity table yet. Extend the laboratory model conceptually with causal claims/evidence first, then migrate only after tests.

Required causal fields for the next version:

- provenance: user | agent | archive | external | system;
- claim status: candidate | active | verified | contradicted | refuted | superseded;
- predicted consequence;
- falsification condition;
- evidence_for / evidence_against;
- explicit links from later evidence to the candidate it tests.

Archive-derived interpretation must never silently become first-person experience.

## Retrieval rule

Historical preservation and causal authority are different.

A refuted or superseded record may remain in history while losing authority over future generation. The production change `type=neq.refuted` is the first working primitive of this rule.

Future context should be compiled from:

```
Axis
+ VerifiedChanges
+ ActiveConstraints
+ OpenQuestions
+ Provenance
```

not from a free-form autobiography.

## Refactoring order

1. Keep production frozen while laboratory tests are built.
2. Normalize owner identity across Telegram / voice / interaction logs.
3. Move fact-candidate handling before any active-memory write.
4. Extend decision-ledger semantics with causal verification.
5. Add deterministic context compilation from verified state.
6. Only then split `server.js` and `agent.js` into transport / memory / continuity / prompt modules.
7. Compare laboratory behavior against unchanged production before deployment.

## Branch roles

- `main`: production baseline.
- `kuzya-memory-lab-20261017`: existing memory/refutation laboratory created before this integration.
- `lint-heartbeat-lab`: heartbeat experiment; keep isolated until its semantics and deployment are audited.
- `causal-continuity-lab`: first causal-ledger sketch; preserve as a historical design branch, do not develop in parallel.
- `continuity-integration-lab`: current integration branch; new continuity work belongs here.

No branch is evidence of autonomous continuity by itself. Git history is evidence of concrete code decisions and changes.
