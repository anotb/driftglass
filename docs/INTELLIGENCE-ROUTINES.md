# Intelligence Routines

An Intelligence Routine is a scheduled sequence of research steps executed through Cloudflare Workflows. Each step has fixed inputs, limits, and a visible run history.

## Available actions

```text
refresh-sources
wait-for-ingest
rebuild-mission
sync-computer
audit-memory
compile-context
prepare-research
checkpoint-memory
```

Each step declares its runtime preference and optionality. The runtime fabric may select Workers, Kitesurf, Chromium, a Mission Computer, or the Companion where the step actually requires it.

## Scheduling and recovery

A Routine may need to wait for Queue ingestion or a Companion result, retry a source, and preserve status between phases. Workflows provide durable progress while keeping each step small and observable.

## Model handoff

`compile-context` and `prepare-research` create a reasoning task or exact Evidence-State Receipt. They do not call a model. The owner can open the task in ChatGPT, Claude, Grok, or another supported reasoning surface.

The person chooses when and where the model runs, and no provider API is required by the Routine.

## Pack routines

Intelligence Pack v3 may include routines alongside sources, Missions, memory seeds, and evidence policy. Pack installation previews scheduled Routine steps inside the selected budget.

A useful Pack routine might:

1. refresh official releases and community discussion,
2. wait for ingestion,
3. rebuild the Mission,
4. checkpoint Memory Graph state,
5. prepare a challenge receipt only when the evidence changed.

## Run history

Every run records:

- trigger
- planned runtime per step
- budget class
- Workflow instance
- step results and failures
- prepared receipt or handoff references
- completion state

Failed or partial runs surface in the Action Center and Judgment workspace.
