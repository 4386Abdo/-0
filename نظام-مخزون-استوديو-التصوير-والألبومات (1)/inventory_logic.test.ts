import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTrafficLightStatus,
  calculateProductionCapacity,
  calculateStockStabilityIndex,
  analyzeItemConsumption,
  generateWhatsAppReport,
  InventoryItem,
  JobTemplate,
  StockMovement
} from './inventory_logic';

const mockItems: InventoryItem[] = [
  { id: '1', sku: 'SKU-1', name: 'ورق جلوسي', category_id: 'c1', specs: '30x40', unit: 'رزمة', quantity: 20, min_limit: 5, reorder_qty: 10, storage_location: 'رف 1' },
  { id: '2', sku: 'SKU-2', name: 'كرتون مكبس', category_id: 'c2', specs: '30x30', unit: 'قطعة', quantity: 25, min_limit: 50, reorder_qty: 100, storage_location: 'رف 2' }, // low
  { id: '3', sku: 'SKU-3', name: 'حبر سماوي', category_id: 'c3', specs: '70ml', unit: 'علبة', quantity: 0, min_limit: 2, reorder_qty: 4, storage_location: 'درج 1' } // out
];

test('calculateTrafficLightStatus detects out-of-stock as danger', () => {
  const result = calculateTrafficLightStatus(mockItems);
  assert.equal(result.level, 'danger');
  assert.equal(result.outCount, 1);
  assert.equal(result.lowCount, 1);
  assert.ok(result.icon.includes('🔴'));
});

test('calculateTrafficLightStatus detects warning when no zero stock but items below min', () => {
  const itemsWithoutOut = mockItems.filter(i => i.quantity > 0);
  const result = calculateTrafficLightStatus(itemsWithoutOut);
  assert.equal(result.level, 'warning');
  assert.equal(result.outCount, 0);
  assert.equal(result.lowCount, 1);
  assert.ok(result.icon.includes('🟠'));
});

test('calculateTrafficLightStatus detects healthy when all items above min', () => {
  const healthyItems: InventoryItem[] = [
    { id: '1', sku: 'SKU-1', name: 'ورق جلوسي', category_id: 'c1', specs: '30x40', unit: 'رزمة', quantity: 20, min_limit: 5, reorder_qty: 10, storage_location: 'رف 1' },
    { id: '2', sku: 'SKU-2', name: 'كرتون مكبس', category_id: 'c2', specs: '30x30', unit: 'قطعة', quantity: 100, min_limit: 50, reorder_qty: 100, storage_location: 'رف 2' }
  ];
  const result = calculateTrafficLightStatus(healthyItems);
  assert.equal(result.level, 'healthy');
  assert.equal(result.outCount, 0);
  assert.equal(result.lowCount, 0);
  assert.ok(result.icon.includes('🟢'));
});

test('calculateProductionCapacity accurately determines possible units and identifies bottleneck', () => {
  const templates: JobTemplate[] = [
    {
      id: 'job-album',
      name: 'ألبوم زفاف ديجيتال 30×30',
      lines: [
        { item_id: '1', quantity: 2 }, // 20 / 2 = 10
        { item_id: '2', quantity: 5 }  // 25 / 5 = 5 (Bottleneck!)
      ]
    }
  ];

  const capacities = calculateProductionCapacity(mockItems, templates);
  assert.equal(capacities.length, 1);
  assert.equal(capacities[0].possibleUnits, 5);
  assert.equal(capacities[0].bottleneckItemId, '2');
  assert.equal(capacities[0].bottleneckItemName, 'كرتون مكبس');
  assert.equal(capacities[0].bottleneckAvailable, 25);
});

test('calculateStockStabilityIndex calculates percentage accurately', () => {
  const index = calculateStockStabilityIndex(mockItems);
  // Total 3, healthy: item 1 (qty 20 > min 5), low: item 2 (qty 25 <= min 50), out: item 3 (qty 0 <= min 2)
  // Healthy is 1/3 = 33%
  assert.equal(index.activeCount, 3);
  assert.equal(index.healthyCount, 1);
  assert.equal(index.percentage, 33);
});

test('analyzeItemConsumption computes daily burn rate and recommended minimum limit', () => {
  const item: InventoryItem = {
    id: '1',
    sku: 'SKU-1',
    name: 'ورق جلوسي',
    category_id: 'c1',
    specs: '30x40',
    unit: 'رزمة',
    quantity: 15,
    min_limit: 4,
    reorder_qty: 10,
    storage_location: 'رف 1'
  };

  const movements: StockMovement[] = [
    { id: 'm1', item_id: '1', quantity_before: 25, quantity_after: 20, change_amount: -5, type: 'consume', reason: 'ألبوم', created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: 'm2', item_id: '1', quantity_before: 20, quantity_after: 15, change_amount: -5, type: 'consume', reason: 'ألبوم', created_at: new Date(Date.now() - 5 * 86400000).toISOString() }
  ];

  const forecast = analyzeItemConsumption(item, movements, 10);
  assert.equal(forecast.dailyBurnRate, 1); // 10 consumed in 10 days = 1/day
  assert.equal(forecast.estimatedRunwayDays, 15); // 15 stock / 1/day = 15 days
  assert.equal(forecast.recommendedMinLimit, 10); // 1/day * 10 = 10
});

test('generateWhatsAppReport creates properly formatted Arabic text', () => {
  const traffic = calculateTrafficLightStatus(mockItems);
  const capacities = calculateProductionCapacity(mockItems, [{ id: 'j1', name: 'ألبوم 30×30', lines: [{ item_id: '1', quantity: 2 }] }]);
  const report = generateWhatsAppReport(traffic, capacities, [mockItems[1], mockItems[2]]);

  assert.ok(report.includes('تقرير جاهزية مخزون الاستوديو'));
  assert.ok(report.includes('ألبوم 30×30'));
  assert.ok(report.includes('حبر سماوي'));
  assert.ok(!report.includes('ج.م'));
  assert.ok(!report.includes('سعر'));
  assert.ok(!report.includes('تكلفة'));
});
