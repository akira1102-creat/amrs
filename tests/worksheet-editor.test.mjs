import assert from "node:assert/strict";
import test from "node:test";
import worksheetModule from "../worksheet-editor.js";

const { columnLabel, createGridDraft, createApplication } = worksheetModule;

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelectorAll() { return []; }
}

function fakeDocument() {
  const host = new FakeElement("worksheetEditorPage");
  return { host, getElementById(id) { return id === host.id ? host : null; } };
}

test("labels spreadsheet columns beyond Z", () => {
  assert.equal(columnLabel(1), "A");
  assert.equal(columnLabel(26), "Z");
  assert.equal(columnLabel(27), "AA");
});

test("worksheet draft submits only rows whose editable cells changed", () => {
  const draft = createGridDraft({
    rows: [
      { rowNumber: 2, recordId: "row-a", values: ["Venetian", "2026/09/08", "2609"] },
      { rowNumber: 3, recordId: "row-b", values: ["Parisian", "2026/09/08", "2609"] },
    ],
  });

  draft.setCell("row-a", 2, "2610");

  assert.equal(draft.changeCount(), 1);
  assert.deepEqual(draft.mutations(), [{
    rowNumber: 2,
    recordId: "row-a",
    originalValues: ["Venetian", "2026/09/08", "2609"],
    values: ["Venetian", "2026/09/08", "2610"],
  }]);
});

test("opens an AE worksheet as an Excel-like locked-header grid", async () => {
  const document = fakeDocument();
  const calls = [];
  const app = createApplication({
    document,
    transport: {
      get: async (query) => {
        calls.push(query);
        return {
          success: true,
          title: "SCL / Worksheet",
          headers: ["CASINO", "DATE", "PO Number"],
          rows: [{ rowNumber: 2, recordId: "row-a", values: ["Venetian", "2026/09/08", "2609"] }],
          page: 1,
          pages: 1,
          total: 1,
        };
      },
      post: async () => ({ success: true, saved: 1 }),
    },
  });

  app.setContext({ kind: "ae", company: "SCL" });
  await app.mount();

  assert.match(calls[0], /action=worksheetGrid/);
  assert.match(calls[0], /company=SCL/);
  assert.match(document.host.innerHTML, /SCL \/ Worksheet/);
  assert.match(document.host.innerHTML, /data-grid-header/);
  assert.match(document.host.innerHTML, /data-grid-cell/);
  assert.match(document.host.innerHTML, /儲存 0 格變更/);
});

test("CVCS worksheet uses the CVCS action and selected Property", async () => {
  const document = fakeDocument();
  const calls = [];
  const app = createApplication({
    document,
    transport: {
      get: async (query) => {
        calls.push(query);
        return { success: true, title: "CVCS Records / Venetian", headers: ["Property", "Date"], rows: [], page: 1, pages: 1, total: 0 };
      },
      post: async () => ({ success: true, saved: 0 }),
    },
  });

  app.setContext({ kind: "cvcs", property: "Venetian" });
  await app.mount();

  assert.match(calls[0], /action=cvcsWorksheetGrid/);
  assert.match(calls[0], /property=Venetian/);
  assert.equal(app.permission(), "cvcs");
});

test("successful save reloads the latest worksheet and clears the local change marker", async () => {
  const document = fakeDocument();
  let value = "3000";
  let reads = 0;
  const app = createApplication({
    document,
    confirm: () => true,
    transport: {
      get: async () => {
        reads += 1;
        return { success: true, title: "SCL / Worksheet", headers: ["Serial No."], rows: [{ rowNumber: 2, recordId: "row-a", values: [value] }], page: 1, pages: 1, total: 1 };
      },
      post: async (payload) => {
        value = payload.mutations[0].values[0];
        return { success: true, saved: 1 };
      },
    },
  });

  app.setContext({ kind: "ae", company: "SCL" });
  await app.mount();
  app.getDraft().setCell("row-a", 0, "3999");
  assert.equal(await app.save(), true);

  assert.equal(reads, 2);
  assert.equal(app.getState().changeCount, 0);
  assert.equal(app.getDraft().rows[0].values[0], "3999");
});
