export function taskOwnsTurn(history = [], turnSequence) {
  const sequence = Number(turnSequence);
  if (!Number.isFinite(sequence)) return false;
  return history.some(
    (event) =>
      event?.type === "task_started"
      && Number(event.turnSequence) === sequence,
  );
}

export function shouldRenderStandaloneToolActivity(orchestration) {
  return !(
    orchestration?.accepted === true
    && typeof orchestration.stepId === "string"
    && orchestration.stepId
  );
}

export function filterTaskTranscriptHistory(history = [], hiddenTaskIds = new Set()) {
  const hidden = hiddenTaskIds instanceof Set
    ? hiddenTaskIds
    : new Set(Array.isArray(hiddenTaskIds) ? hiddenTaskIds : []);
  return history.filter((event) => !hidden.has(event?.taskId));
}
