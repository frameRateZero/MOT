#!/usr/bin/env python3
"""
Split a mot_results_*.json bundle into three CSV files.

Usage:
    python3 split_mot.py mot_results_2025-01-01.json

Outputs:
    mot_trials.csv
    mot_events.csv
    mot_timeseries.csv
"""
import json, sys, pathlib

if len(sys.argv) < 2:
    print("Usage: python3 split_mot.py mot_results_*.json")
    sys.exit(1)

bundle_path = pathlib.Path(sys.argv[1])
if not bundle_path.exists():
    print(f"File not found: {bundle_path}")
    sys.exit(1)

with open(bundle_path) as f:
    bundle = json.load(f)

out_dir = bundle_path.parent

for key in ('trials', 'events', 'timeseries'):
    if key not in bundle:
        print(f"Warning: no '{key}' key in bundle")
        continue
    out_path = out_dir / f'mot_{key}.csv'
    out_path.write_text(bundle[key])
    n_rows = bundle[key].count('\n')
    print(f"Wrote {out_path}  ({n_rows} rows)")

print("Done.")
