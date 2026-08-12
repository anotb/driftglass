# Pack overlays and forks

Intelligence Packs need a clean update path without erasing local judgment.

## Overlay model

An installed Pack remains an upstream base. Local changes are captured in a separate overlay:

- disabled source IDs
- source schedule, weight, enabled-state, or configuration overrides
- added cloud or Companion sources
- Mission overrides
- added Missions
- added interest terms
- local evidence-policy or routine changes where supported

## Update flow

When an upstream Pack changes:

1. fetch and validate the new Pack,
2. apply the existing overlay,
3. report missing or conflicting source and Mission references,
4. leave conflicts visible for review,
5. update only after explicit confirmation.

The owner’s customization is not flattened into the upstream manifest.

## Capture existing customization

The dashboard can compare the currently installed sources and Missions with the Pack snapshot and derive an overlay. This makes customization preservable even when it began as ordinary dashboard edits.

## Fork

The effective Pack after overlay application can be exported as a portable v3 Pack with lineage metadata pointing to its upstream source.

A fork is appropriate when the customized method has become independently useful. An overlay is better when the owner still wants upstream updates.
