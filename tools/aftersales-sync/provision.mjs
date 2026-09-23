const CARD_SHOE = 'Card Shoe';

function onlyActive(rows, label) {
  if (rows.length > 1) throw new Error(`Ambiguous ${label}`);
  if (rows.length && !rows[0].isActive) throw new Error(`Inactive ${label}`);
  return rows[0] || null;
}

async function ensureNamed(client, listRows, name, path, payload, label) {
  const lookup = async () => onlyActive((await listRows()).filter(item => item.name?.toLowerCase() === name.toLowerCase()), label);
  const before = await lookup();
  if (before) return before.id;
  try {
    await client.post(path, payload);
  } catch (error) {
    if (!await lookup()) throw error;
  }
  const after = await lookup();
  if (!after) throw new Error(`Unconfirmed ${label} creation`);
  return after.id;
}

async function ensureCatalog(client, model) {
  const options = () => client.get('/api/products/options');
  const typeId = await ensureNamed(client, async () => (await options()).productTypes,
    CARD_SHOE, '/api/products/types', { name: CARD_SHOE }, 'product type');
  const modelId = await ensureNamed(client, async () => (await options()).productModels.filter(item => item.parentId === typeId),
    model, '/api/products/models', { productTypeId: typeId, name: model }, 'product model');
  const systemId = await ensureNamed(client, async () => (await options()).productSystems,
    CARD_SHOE, '/api/products/systems', { name: CARD_SHOE }, 'product system');
  const templates = async () => (await options()).devices.filter(item => item.productSystemId === systemId);
  if (!(await templates()).length) {
    try {
      await client.post('/api/products/devices', {
        productSystemId: systemId, productTypeId: typeId, deviceName: CARD_SHOE,
        slotCode: 'CARD-SHOE-1', sortOrder: 1, isRequired: true,
      });
    } catch (error) {
      if (!(await templates()).length) throw error;
    }
  }
  const current = await templates();
  if (current.length !== 1 || !current[0].isActive || current[0].productTypeId !== typeId) {
    throw new Error('Card Shoe system template is not a single active Card Shoe slot');
  }
  return { typeId, modelId, systemId, templateId: current[0].id };
}

function installedMachine(db, serialNo) {
  return db.prepare(`
    SELECT i.SystemNo, i.CustomerId, i.BranchId, i.ProductSystemId,
           asset.ProductModelId, asset.ProductTypeId
    FROM product_assets AS asset
    JOIN installation_devices AS device ON device.ProductAssetId = asset.Id
    JOIN installations AS i ON i.Id = device.InstallationId
    WHERE asset.SerialNumber = ? COLLATE NOCASE AND asset.IsDeleted = 0 AND i.IsActive = 1
  `).all(serialNo);
}

function confirmsMachine(db, machine, ids) {
  const rows = installedMachine(db, machine.serialNo);
  return rows.length === 1 && rows[0].SystemNo.toLowerCase() === machine.serialNo.toLowerCase()
    && rows[0].CustomerId === ids.customerId && rows[0].BranchId === ids.branchId
    && rows[0].ProductSystemId === ids.systemId && rows[0].ProductModelId === ids.modelId
    && rows[0].ProductTypeId === ids.typeId;
}

export async function provisionMachines(machines, db, client, { installDateSource = '' } = {}) {
  if (installDateSource !== 'earliest-service') throw new Error('Installation date source must be explicitly selected');
  const result = { created: 0, failed: 0 };
  for (const machine of machines) {
    try {
      const customers = () => client.get('/api/customers');
      const customerId = await ensureNamed(client, customers, machine.customer, '/api/customers',
        { name: machine.customer }, 'customer');
      const branches = async () => (await customers()).find(item => item.id === customerId)?.branches || [];
      const branchId = await ensureNamed(client, branches, machine.branch, '/api/branches',
        { customerId, name: machine.branch }, 'branch');
      const { typeId, modelId, systemId, templateId } = await ensureCatalog(client, machine.model);
      const ids = { customerId, branchId, typeId, modelId, systemId };
      if (!confirmsMachine(db, machine, ids)) {
        if (db.prepare('SELECT COUNT(*) AS total FROM product_assets WHERE SerialNumber = ? COLLATE NOCASE').get(machine.serialNo).total
          || db.prepare('SELECT COUNT(*) AS total FROM installations WHERE SystemNo = ? COLLATE NOCASE').get(machine.serialNo).total) {
          throw new Error('Machine identifier already belongs to another asset or system');
        }
        try {
          await client.post('/api/intake/installations', {
            customerId, branchId, productSystemId: systemId, systemNo: machine.serialNo,
            installDate: machine.earliestServiceDate,
            devices: [{ templateId, serialNumber: machine.serialNo, productModelId: modelId,
              purchaseDate: null, attributeValue: null }],
          });
        } catch (error) {
          if (!confirmsMachine(db, machine, ids)) throw error;
        }
      }
      if (!confirmsMachine(db, machine, ids)) throw new Error('Unconfirmed machine creation');
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      const reason = Number(error?.status) ? `HTTP ${error.status}` : 'configuration or conflict';
      result.failureReasons ??= {};
      result.failureReasons[reason] = (result.failureReasons[reason] || 0) + 1;
    }
  }
  return result;
}
