export const pk = (householdId: string) => `HH#${householdId}`;

export const sk = {
  household: () => 'HOUSEHOLD',
  appliance: (id: string) => `APPL#${id}`,
  maintenance: (applianceId: string, taskType: string) => `MAINT#${applianceId}#${taskType}`,
  log: (createdAt: string, id: string) => `LOG#${createdAt}#${id}`,
  doc: (id: string) => `DOC#${id}`,
  visit: (id: string) => `VISIT#${id}`,
  event: (at: string, id: string) => `EVENT#${at}#${id}`,
  alert: (id: string) => `ALERT#${id}`,
  device: (ringDeviceId: string) => `DEVICE#${ringDeviceId}`
};

export const gsi1 = { due: (householdId: string) => `HH#${householdId}#DUE` };
export const gsi2 = { visit: (householdId: string) => `HH#${householdId}#VISIT` };
