# Driftglass Lenses

A Lens is a portable bundle of sources, Research Missions, schedules, and interest terms. It can be installed from a file, a raw GitHub URL, or a Driftglass deep link.

## Install link

```text
https://YOUR-DRIFTGLASS/?lens=https%3A%2F%2Fraw.githubusercontent.com%2FOWNER%2FREPO%2Fmain%2Flenses%2Fmy-lens.json
```

After the owner unlocks Driftglass, the Lens is previewed and installed with one confirmation.

## Add a community Lens

1. Copy an example from `lenses/examples/`.
2. Keep source IDs unique and stable.
3. Prefer cloud-only adapters. Mark `requiresCompanion: true` only when the Lens includes signed-in collector capabilities.
4. Run `npm run lenses:check`.
5. Open a pull request adding the JSON file.

The generated public catalog lives under `public/lenses/` and is included in the one-click Worker deployment.
