// inventory_logic.ts - Pure functions for studio inventory calculations
// 0% Prices/Money - Quantities, Production Capacity, Depletion, and Stability only

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  category_id: string;
  specs: string;
  unit: string;
  quantity: number;
  min_limit: number;
  reorder_qty: number;
  storage_location: string;
  supplier_id?: string;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface JobTemplateLine {
  item_id: string;
  quantity: number;
}

export interface JobTemplate {
  id: string;
  name: string;
  lines: JobTemplateLine[];
}

export interface StockMovement {
  id: string;
  item_id: string;
  quantity_before: number;
  quantity_after: number;
  change_amount: number;
  type: string;
  reason: string;
  created_by?: string;
  created_at: string;
}

export interface TrafficLightResult {
  level: 'healthy' | 'warning' | 'danger';
  color: string;
  icon: string;
  title: string;
  description: string;
  outCount: number;
  lowCount: number;
}

export function calculateTrafficLightStatus(items: InventoryItem[]): TrafficLightResult {
  const activeItems = items.filter(i => !i.is_archived);
  if (activeItems.length === 0) {
    return {
      level: 'healthy',
      color: '#16a34a',
      icon: '🟢',
      title: 'المستودع جاهز',
      description: 'لا توجد أصناف مسجلة حالياً',
      outCount: 0,
      lowCount: 0
    };
  }

  let outCount = 0;
  let lowCount = 0;

  for (const item of activeItems) {
    if (item.quantity <= 0) {
      outCount++;
    } else if (item.quantity <= item.min_limit) {
      lowCount++;
    }
  }

  if (outCount > 0) {
    return {
      level: 'danger',
      color: '#dc2626',
      icon: '🔴',
      title: 'خطر حرج - خط الإنتاج مهدد بالتوقف',
      description: `يوجد ${outCount} صنف نفد رصيده بالكامل، و ${lowCount} صنف قارب على النفاد. يلزم التوريد فوراً.`,
      outCount,
      lowCount
    };
  }

  if (lowCount > 0) {
    return {
      level: 'warning',
      color: '#d97706',
      icon: '🟠',
      title: 'تنبيه استباقي - خامات أوشكت على النفاد',
      description: `يوجد ${lowCount} صنف أقل من الحد الأدنى للأمان، تكفي لأقل من أسبوع من العمل المعتاد.`,
      outCount,
      lowCount
    };
  }

  return {
    level: 'healthy',
    color: '#16a34a',
    icon: '🟢',
    title: 'المخزون مستقر تماماً والجاهزية ممتازة',
    description: 'جميع الخامات الأساسية متوفرة بأرصدة آمنة تتجاوز الحد الأدنى المطلوب للاستوديو.',
    outCount: 0,
    lowCount: 0
  };
}

export interface CapacityResult {
  templateId: string;
  templateName: string;
  possibleUnits: number;
  bottleneckItemId: string | null;
  bottleneckItemName: string | null;
  bottleneckAvailable: number;
  bottleneckNeededPerUnit: number;
}

export function calculateProductionCapacity(items: InventoryItem[], templates: JobTemplate[]): CapacityResult[] {
  const activeItemsMap = new Map<string, InventoryItem>();
  for (const item of items) {
    if (!item.is_archived) {
      activeItemsMap.set(item.id, item);
    }
  }

  return templates.map(template => {
    if (!template.lines || template.lines.length === 0) {
      return {
        templateId: template.id,
        templateName: template.name,
        possibleUnits: 0,
        bottleneckItemId: null,
        bottleneckItemName: null,
        bottleneckAvailable: 0,
        bottleneckNeededPerUnit: 0
      };
    }

    let minUnits = Infinity;
    let bottleneckItem: InventoryItem | null = null;
    let bottleneckNeeded = 0;

    for (const line of template.lines) {
      const item = activeItemsMap.get(line.item_id);
      const available = item ? Math.max(0, item.quantity) : 0;
      const needed = line.quantity;

      if (needed <= 0) continue;

      const unitsForThisItem = Math.floor(available / needed);

      if (unitsForThisItem < minUnits) {
        minUnits = unitsForThisItem;
        bottleneckItem = item || null;
        bottleneckNeeded = needed;
      }
    }

    const possible = minUnits === Infinity ? 0 : minUnits;

    return {
      templateId: template.id,
      templateName: template.name,
      possibleUnits: possible,
      bottleneckItemId: bottleneckItem ? bottleneckItem.id : null,
      bottleneckItemName: bottleneckItem ? bottleneckItem.name : 'غير محدد',
      bottleneckAvailable: bottleneckItem ? bottleneckItem.quantity : 0,
      bottleneckNeededPerUnit: bottleneckNeeded
    };
  });
}

export function calculateStockStabilityIndex(items: InventoryItem[]): { percentage: number; activeCount: number; healthyCount: number } {
  const activeItems = items.filter(i => !i.is_archived);
  if (activeItems.length === 0) return { percentage: 100, activeCount: 0, healthyCount: 0 };

  const healthyCount = activeItems.filter(i => i.quantity > i.min_limit).length;
  const percentage = Math.round((healthyCount / activeItems.length) * 100);

  return { percentage, activeCount: activeItems.length, healthyCount };
}

export interface ItemForecast {
  itemId: string;
  itemName: string;
  currentStock: number;
  dailyBurnRate: number;
  estimatedRunwayDays: number | null;
  recommendedMinLimit: number;
  status: 'critical' | 'warning' | 'normal';
}

export function analyzeItemConsumption(item: InventoryItem, movements: StockMovement[], daysWindow: number = 30): ItemForecast {
  const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
  const recentMovements = movements.filter(m => m.item_id === item.id && new Date(m.created_at).getTime() >= cutoff);

  let totalConsumed = 0;
  for (const m of recentMovements) {
    if (m.change_amount < 0) {
      totalConsumed += Math.abs(m.change_amount);
    }
  }

  const dailyBurnRate = totalConsumed > 0 ? Number((totalConsumed / daysWindow).toFixed(2)) : 0;
  const estimatedRunwayDays = dailyBurnRate > 0 ? Math.floor(item.quantity / dailyBurnRate) : null;

  // Recommended safety stock covers 7 days of normal consumption + 3 days buffer
  const recommendedMinLimit = dailyBurnRate > 0 ? Math.ceil(dailyBurnRate * 10) : item.min_limit;

  let status: 'critical' | 'warning' | 'normal' = 'normal';
  if (item.quantity <= 0 || (estimatedRunwayDays !== null && estimatedRunwayDays <= 2)) {
    status = 'critical';
  } else if (item.quantity <= item.min_limit || (estimatedRunwayDays !== null && estimatedRunwayDays <= 7)) {
    status = 'warning';
  }

  return {
    itemId: item.id,
    itemName: item.name,
    currentStock: item.quantity,
    dailyBurnRate,
    estimatedRunwayDays,
    recommendedMinLimit,
    status
  };
}

export function generateWhatsAppReport(
  trafficStatus: TrafficLightResult,
  capacities: CapacityResult[],
  urgentItems: InventoryItem[]
): string {
  const dateStr = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let msg = `📸 *تقرير جاهزية مخزون الاستوديو* (${dateStr})\n`;
  msg += `الحالة العامة: ${trafficStatus.icon} ${trafficStatus.title}\n\n`;

  msg += `🎯 *قدرة الإنتاج الجاهزة للتسليم فوراً:*\n`;
  if (capacities.length > 0) {
    capacities.forEach(c => {
      msg += `• ${c.templateName}: جاهز لإنتاج (${c.possibleUnits} قطعة)`;
      if (c.possibleUnits <= 5 && c.bottleneckItemName) {
        msg += ` [عنق الزجاجة: ${c.bottleneckItemName} - المتبقي: ${c.bottleneckAvailable}]`;
      }
      msg += `\n`;
    });
  } else {
    msg += `• لا توجد قوالب شغل محددة.\n`;
  }

  msg += `\n⚠️ *الأصناف الحرجة التي تحتاج توريد عاجل:*\n`;
  if (urgentItems.length > 0) {
    urgentItems.slice(0, 6).forEach(item => {
      msg += `• ${item.name}: الرصيد الحالي (${item.quantity} ${item.unit}) - الحد الأدنى (${item.min_limit})\n`;
    });
    if (urgentItems.length > 6) {
      msg += `• بالإضافة إلى ${urgentItems.length - 6} صنف آخر في قائمة النواقص.\n`;
    }
  } else {
    msg += `• جميع الخامات متوفرة ولا يوجد نواقص عاجلة.\n`;
  }

  msg += `\n_تم الإنشاء تلقائياً عبر نظام إدارة مخزون الاستوديو_`;
  return msg;
}
