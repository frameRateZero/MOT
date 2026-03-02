# MOT Factorial Load Model

Multiple Object Tracking experiment for building a speed × crowding load model.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `app.js` | Experiment logic (vanilla JS, no framework) |
| `recordings.js` | 3 pre-generated 22s ball trajectories (embedded) |
| `trials.csv` | 20 pre-defined trial parameters |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (offline cache) |
| `icon-192.png` | PWA icon |
| `icon-512.png` | PWA icon |

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `mot-experiment`)
2. Upload all files to the root of the `main` branch
3. Go to **Settings → Pages → Source → Deploy from branch → main / root**
4. Your app will be live at `https://yourusername.github.io/mot-experiment/`

## Install as PWA on iPhone

1. Open the GitHub Pages URL in **Safari**
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Launch from home screen — runs full-screen, works offline

## Experiment Design

- **20 trials**, 8 seconds each, randomised order
- **3 recordings** of natural ball physics (22s each, 10 balls, 150px/s reference)
- **Speeds**: 0.5× / 1.0× / 1.8× of reference → 75 / 150 / 270 px/s
- **Distractors**: 2 / 4 / 6 extra beyond 3 targets → 5 / 7 / 9 total balls
- **Targets**: always balls 0–2 (highlighted at memorisation, then identical thereafter)
- **No re-memorisation**: targets are consistent across trials

## Load Model

```
L(t) = α × speed_normalised + β × crowding_pressure(t)
     = 0.45 × (speed / 270) + 0.55 × max(0, 1 - ambientBoumaRatio / 3)
```

where `ambientBoumaRatio` = min spacing / (0.5 × eccentricity) across all target–distractor pairs.

## CSV Output

After completing the session, **EXPORT ALL CSV** downloads three files:

### `mot_trials.csv`
One row per trial. Key columns:
- `trial_id`, `rec_name`, `speed_mult`, `n_distractors`
- `score` (0–1), `missed` (targets lost)
- `mean_load`, `peak_load` — load model values
- `mean_amb_bouma`, `pct_below_crit` — crowding exposure

### `mot_events.csv`
One row per near-miss event (target–distractor pair crossing below 1.5× Bouma critical spacing).
- `outcome`: `swap` / `miss_event` / `miss_none` / `survived`
- `min_bouma` — closest approach as fraction of critical spacing
- `tgt_id`, `dst_id` — which pair

### `mot_timeseries.csv`
One row per 12Hz sample during tracking.
- `ambient_bouma` — minimum Bouma ratio across all target–distractor pairs
- `load` — combined load model value
- `speed_comp`, `crowd_press` — individual components

## Analysis Questions

Feed CSVs into a new chat for analysis:
1. Is the speed effect on miss rate linear or threshold?
2. Is the distractor effect linear?
3. Do speed and crowding contribute independently (additive) or interact (multiplicative)?
4. Does the load model monotonically predict miss rate across load quartiles?
5. Are swaps preferentially associated with low Bouma ratios (identity confusion) vs high load (capacity failure)?
