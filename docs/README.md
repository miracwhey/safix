# Docs Overview

This directory contains non-code project documentation that should not live in the repository root.

## Structure

### `audits/`
Audit-style documents used to inspect system state, architecture quality, migration readiness, or domain consistency.

Examples:
- product readiness audits
- migration reviews
- system audits
- discovery audits
- schema catchup audits

### `summaries/`
Shorter outcome-oriented documents that summarize a completed fix, alignment pass, or focused workstream.

Examples:
- fix summaries
- schema alignment summaries
- task summaries

### `strategy/`
Documents that describe a planned direction, structural realignment, or problem-solving approach.

Examples:
- realignment strategy
- targeted fix strategy
- structural cleanup strategy

## Rule

New markdown documents of this type should be placed in one of these folders instead of the repository root.

- put inspections and reviews in `audits/`
- put result summaries in `summaries/`
- put directional or planning documents in `strategy/`

## Goal

Keep the repo root focused on product code, config, and core entrypoint files while preserving important supporting documentation in a predictable location.
