const MAX_MATRIX_CELLS = 250_000;

function splitLines(content) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function diffSkillContent(currentContent, snapshotContent) {
  const current = splitLines(currentContent);
  const snapshot = splitLines(snapshotContent);
  if ((current.length + 1) * (snapshot.length + 1) > MAX_MATRIX_CELLS) {
    return {
      available: false,
      reason: "diff-too-large",
      summary: {
        currentLines: current.length,
        snapshotLines: snapshot.length,
      },
      lines: [],
    };
  }

  const width = snapshot.length + 1;
  const matrix = new Uint16Array((current.length + 1) * width);
  for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
    for (let snapshotIndex = snapshot.length - 1; snapshotIndex >= 0; snapshotIndex -= 1) {
      const index = currentIndex * width + snapshotIndex;
      matrix[index] =
        current[currentIndex] === snapshot[snapshotIndex]
          ? matrix[(currentIndex + 1) * width + snapshotIndex + 1] + 1
          : Math.max(
              matrix[(currentIndex + 1) * width + snapshotIndex],
              matrix[currentIndex * width + snapshotIndex + 1],
            );
    }
  }

  const lines = [];
  let currentIndex = 0;
  let snapshotIndex = 0;
  let currentLine = 1;
  let snapshotLine = 1;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  while (currentIndex < current.length || snapshotIndex < snapshot.length) {
    if (
      currentIndex < current.length &&
      snapshotIndex < snapshot.length &&
      current[currentIndex] === snapshot[snapshotIndex]
    ) {
      lines.push({
        kind: "same",
        text: current[currentIndex],
        currentLine,
        snapshotLine,
      });
      currentIndex += 1;
      snapshotIndex += 1;
      currentLine += 1;
      snapshotLine += 1;
      unchanged += 1;
    } else if (
      snapshotIndex < snapshot.length &&
      (currentIndex === current.length ||
        matrix[currentIndex * width + snapshotIndex + 1] >=
          matrix[(currentIndex + 1) * width + snapshotIndex])
    ) {
      lines.push({
        kind: "add",
        text: snapshot[snapshotIndex],
        currentLine: null,
        snapshotLine,
      });
      snapshotIndex += 1;
      snapshotLine += 1;
      added += 1;
    } else {
      lines.push({
        kind: "remove",
        text: current[currentIndex],
        currentLine,
        snapshotLine: null,
      });
      currentIndex += 1;
      currentLine += 1;
      removed += 1;
    }
  }

  return {
    available: true,
    direction: "current-to-snapshot",
    summary: { added, removed, unchanged },
    lines,
  };
}
