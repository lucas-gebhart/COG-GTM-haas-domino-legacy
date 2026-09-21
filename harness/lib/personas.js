'use strict';

/**
 * Synthetic identities that the EAMS-A/SAML login stub can assert. Roles mirror the ACL
 * role assignments in nsf/<db>/acl.dxl. Nothing here is a credential.
 */

const PERSONAS = [
  {
    id: 'whitcombe',
    name: 'CN=Lorraine Whitcombe/OU=CHPSID/O=TACOM',
    title: 'Heraldry Program Lead, Clothing & Heraldry PSID',
    groups: ['TACOM-CHPSID-Staff', 'TACOM-CHPSID-Heraldry-Leads', 'HAAS-Administrators'],
    roles: ['[TACOM]', '[CSR]', '[Admin]', '[SESApprover]'],
    access: 'Manager',
  },
  {
    id: 'vasquez-holm',
    name: 'CN=Renata Vasquez-Holm/OU=CHPSID/O=TACOM',
    title: 'Customer Service Representative, Veteran Medals',
    groups: ['TACOM-CHPSID-Staff', 'TACOM-CHPSID-Awards-CSR'],
    roles: ['[TACOM]', '[CSR]'],
    access: 'Editor',
  },
  {
    id: 'amundsen',
    name: 'CN=Hector Amundsen/OU=CHPSID/O=TACOM',
    title: 'Engraving Shop',
    groups: ['TACOM-CHPSID-Engraving'],
    roles: ['[Engraver]'],
    access: 'Author',
  },
  {
    id: 'kowalczyk',
    name: 'CN=Benedetta Kowalczyk/OU=CHPSID/O=TACOM',
    title: 'Assembly / QC',
    groups: ['TACOM-CHPSID-Assembly'],
    roles: ['[Assembler]'],
    access: 'Author',
  },
  {
    id: 'ferreira-lund',
    name: 'CN=Oswaldo Ferreira-Lund/OU=CHPSID/O=TACOM',
    title: 'Warehouse / Shipping',
    groups: ['TACOM-CHPSID-Warehouse'],
    roles: ['[Warehouse]'],
    access: 'Author',
  },
  {
    id: 'blankenship',
    name: 'CN=Theodore Blankenship/OU=TroopSupport/O=DLA',
    title: 'DLA Troop Support, Heraldry Liaison',
    groups: ['DLA-TroopSupport-Heraldry'],
    roles: ['[DLA]'],
    access: 'Author',
  },
  {
    id: 'sfc-okonkwo',
    name: 'CN=Adaeze Okonkwo/OU=Units/O=Army',
    title: 'SFC, Supply Sergeant (S4), 1-503 IN, W6KJAA',
    groups: ['Army-Units-Requesters'],
    roles: [],
    access: 'Author',
    dodaac: 'W6KJAA',
    uic: 'WAB1AA',
    unit: '1st Battalion, 503rd Infantry Regiment',
  },
  {
    id: 'halvorsen',
    name: 'CN=Gus Halvorsen/O=Liberty Colors LLC',
    title: 'Vendor production manager',
    groups: ['Heraldry-Vendors'],
    roles: ['[Vendor]'],
    access: 'Author',
    vendorKey: '1CLR7',
  },
  {
    id: 'hrc-transfer',
    name: 'CN=HRC-Transfer/OU=Agents/O=TACOM',
    title: 'Automation account - authorization file transfer',
    groups: [],
    roles: ['[Importer]'],
    access: 'Editor',
  },
];

const ANONYMOUS = { id: 'anonymous', name: 'Anonymous', title: '', groups: [], roles: [], access: 'Reader', anonymous: true };

function byId(id) {
  return PERSONAS.find((p) => p.id === id) || null;
}

function hasRole(user, ...roles) {
  return roles.some((r) => (user.roles || []).includes(r));
}

function commonName(name) {
  const m = /CN=([^/]+)/.exec(name || '');
  return m ? m[1] : name;
}

module.exports = { PERSONAS, ANONYMOUS, byId, hasRole, commonName };
