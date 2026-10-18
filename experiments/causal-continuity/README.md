# Causal Continuity Lab

Experimental branch. Nothing here is deployed to production.

## Problem

The current evolution path can describe a transition and immediately write an after-state. That collapses three different things:

1. an event happened;
2. the agent interpreted the event as a change;
3. later behavior demonstrated that the change had consequences.

This branch keeps them separate.

## Core invariant

```
Evidence != Interpretation != Consequence
```

A proposed rule begins as `candidate`. The event that creates the candidate is not allowed to verify it.

A later opportunity may produce evidence:

```
CandidateRule(t)
  -> FutureOpportunity(t+n)
  -> ObservedBehavior(t+n)
  -> supports | contradicts | neutral
```

Only later evidence may justify promotion to `verified`.

## Historical preservation

Records are not deleted merely because they are wrong. Their causal status changes:

```
candidate | active | verified | contradicted | refuted | superseded
```

The existing production behavior that excludes `memory.type = refuted` is the first primitive example of this principle: preserve the historical record while removing its authority over future generation.

## State compilation

A future continuity checkpoint should be compiled from separate layers:

```
Axis
+ VerifiedChanges
+ ActiveConstraints
+ OpenQuestions
+ Provenance
```

It should not be a free-form autobiography generated from the same event that claims to have changed the state.

## Provenance

Every candidate records where it came from: user, agent inference, archive, external source, or system process. Archive-derived interpretations must never silently become first-person experience.

## Safety of this experiment

The SQL migration is intentionally stored only in this Git branch. It has not been run against Supabase. No Render service points to this branch. Production behavior is unchanged.
