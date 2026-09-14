import { COMPANIES, companySchema, BROKEN_PARTS_HEADERS } from '../worker/src/config.mjs';
import { CVCS_RECORD_HEADERS, CVCS_BROKEN_PARTS_HEADERS, CVCS_OPTION_SHEETS } from '../worker/src/cvcs-domain.mjs';
import { MGM_CHECK_REQUEST_HEADERS } from '../worker/src/domain.mjs';

export function initializeWorkbooks(sheets) {
  const definitions = {};
  for (const company of COMPANIES) definitions[company] = {
    Worksheet: [companySchema(company).fields],
    'Broken Parts List': [BROKEN_PARTS_HEADERS],
    Template: [['Reason', 'Action'], ['PM', 'Preventive Maintenance']],
    'AA TAG': [['Serial No.', 'AA Tag']],
    Monthly: [],
  };
  definitions.parts = { 'Parts Code': [['Parts No.', 'Required Parts(JP)', 'Required Parts(EN)']] };
  definitions.schedule = { Setup: [] };
  definitions.cvcs = {
    'CVCS Records': [CVCS_RECORD_HEADERS],
    'CVCS Broken Parts': [CVCS_BROKEN_PARTS_HEADERS],
    'CVCS Parts List': [['Parts No.', 'Required Parts (EN)']],
    ...Object.fromEntries(Object.values(CVCS_OPTION_SHEETS).map(title => [title, [[title]]])),
  };
  definitions['galaxy-log'] = { 'Galaxy Log': [['SN', '指定 Log 日期', '取 Log 日期']] };
  definitions['mgm-check-request'] = { 'MGM Macau': [MGM_CHECK_REQUEST_HEADERS], 'MGM Cotai': [MGM_CHECK_REQUEST_HEADERS] };
  for (const [id, worksheets] of Object.entries(definitions)) if (!sheets.exists(id)) sheets.initialize(id, worksheets);
}
