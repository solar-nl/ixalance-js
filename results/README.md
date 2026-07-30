# Retained benchmark results

This directory contains the small, curated CSVs cited by the Jizz and Stash optimization
notes. They document the before/after evidence behind retained performance changes.

Raw benchmark runs, cold-start checkpoints, memory snapshots, frame dumps and audio renders
belong under the ignored `out/` directory. They are machine-specific or reproducible,
potentially very large, and should not be committed.

To generate a fresh result, use the benchmark commands in
[`README.md`](../README.md). Promote a CSV from `out/` into this directory only when a
written optimization note cites it.
