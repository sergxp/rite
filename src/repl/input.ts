export function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

export function getLineStart(value: string, cursor: number): number {
  const index = value.lastIndexOf("\n", Math.max(0, cursor - 1));
  return index === -1 ? 0 : index + 1;
}

export function getLineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor);
  return index === -1 ? value.length : index;
}

export function deletePreviousWord(value: string, cursor: number): {
  value: string;
  cursor: number;
} {
  if (cursor === 0) {
    return { value, cursor };
  }

  let start = cursor;
  while (start > 0 && /\s/.test(value[start - 1])) {
    start--;
  }
  while (start > 0 && isWordChar(value[start - 1])) {
    start--;
  }

  return {
    value: value.slice(0, start) + value.slice(cursor),
    cursor: start,
  };
}

export function killToLineStart(value: string, cursor: number): {
  value: string;
  cursor: number;
} {
  const start = getLineStart(value, cursor);
  return {
    value: value.slice(0, start) + value.slice(cursor),
    cursor: start,
  };
}

export function insertAtCursor(
  value: string,
  cursor: number,
  insert: string
): { value: string; cursor: number } {
  const next = value.slice(0, cursor) + insert + value.slice(cursor);
  return { value: next, cursor: cursor + insert.length };
}

export function deleteBackward(value: string, cursor: number): {
  value: string;
  cursor: number;
} {
  if (cursor === 0) {
    return { value, cursor };
  }

  return {
    value: value.slice(0, cursor - 1) + value.slice(cursor),
    cursor: cursor - 1,
  };
}
