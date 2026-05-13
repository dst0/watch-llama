import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSensorsJson } from '../src/providers/system.js';
import { ThermalManager } from '../src/utils/thermal.js';

test('parseSensorsJson picks hottest temperature and retains NVMe', () => {
    const sensorsJson = JSON.stringify({
        'k10temp-pci-00c3': {
            Adapter: 'PCI adapter',
            Tctl: { temp1_input: 45.0 },
            Tdie: { temp2_input: 40.0 }
        },
        'amdgpu-pci-0300': {
            Adapter: 'PCI adapter',
            edge: { temp1_input: 77.0 },
            junction: { temp2_input: 82.0 }
        },
        'nvme-pci-0100': {
            Adapter: 'PCI adapter',
            Composite: { temp1_input: 35.0 }
        }
    });

    const parsed = parseSensorsJson(sensorsJson);
    assert.equal(parsed.maxTemp, 82);
    assert.deepEqual(parsed.extraTemps, [{ label: 'NVMe', tempC: 35 }]);
});

test('thermal colors and title blocks follow the expected thresholds', () => {
    assert.equal(ThermalManager.getColor(30), 'blue');
    assert.equal(ThermalManager.getColor(40), 'green');
    assert.equal(ThermalManager.getColor(60), 'yellow');
    assert.equal(ThermalManager.getColor(77), 'orange');
    assert.equal(ThermalManager.getColor(90), 'red');
    assert.equal(ThermalManager.getTitleBlocks(30), '🟦');
    assert.equal(ThermalManager.getTitleBlocks(77), '🟧');
});
