import { writeFileSync } from 'node:fs';

// A portable data-only backup. Authentication material is deliberately excluded.
export function saveWorksheetBackup(sheets, destination) {
  const snapshot = sheets.snapshot();
  writeFileSync(destination, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
  return { workbooks: snapshot.workbooks.length, createdAt: snapshot.createdAt };
}
