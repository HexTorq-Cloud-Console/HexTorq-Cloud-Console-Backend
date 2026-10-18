import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceTemplates } from '../src/templates.js';

test('service templates have unique keys and supported service types', () => {
  const keys = serviceTemplates.map((template) => template.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const template of serviceTemplates) {
    assert.ok(['PM2', 'STATIC_FRONTEND'].includes(template.type));
    assert.ok(template.name);
    assert.ok(template.commands);
  }
});

test('every template has deployment commands', () => {
  for (const template of serviceTemplates) {
    assert.ok(Object.keys(template.commands).length > 0);
  }
});
