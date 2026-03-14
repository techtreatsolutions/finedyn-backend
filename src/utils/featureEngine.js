'use strict';

const { query } = require('../config/database');

async function getEffectiveFeatures(restaurantId) {
  // Fetch plan limits from active subscription
  const [planRows] = await query(
    `SELECT p.max_floors, p.max_tables, p.max_menu_items, p.max_staff,
            p.max_bills_per_day, p.max_bills_per_month,
            p.feature_waiter_app, p.feature_digital_menu, p.feature_edine_in_orders,
            p.feature_reservations, p.feature_inventory,
            p.feature_expense_management, p.feature_employee_management,
            p.feature_kds, p.feature_analytics
     FROM restaurants r
     JOIN plans p ON p.id = r.plan_id
     WHERE r.id = ? AND r.subscription_status IN ('active','trial')
     LIMIT 1`,
    [restaurantId]
  );

  // Fetch manual overrides
  const [overrideRows] = await query(
    `SELECT feature_name, override_value FROM feature_overrides WHERE restaurant_id = ?`,
    [restaurantId]
  );

  const defaults = {
    max_floors: 2,
    max_tables: 20,
    max_menu_items: 100,
    max_staff: 10,
    max_bills_per_day: 200,
    max_bills_per_month: 5000,
    feature_waiter_app: true,
    feature_digital_menu: true,
    feature_edine_in_orders: true,
    feature_reservations: true,
    feature_inventory: true,
    feature_expense_management: true,
    feature_employee_management: true,
    feature_kds: true,
    feature_analytics: true,
  };

  let features = planRows && planRows.length > 0 ? { ...planRows[0] } : { ...defaults };

  // Apply overrides
  for (const row of overrideRows) {
    const val = row.override_value;
    // Try to parse as number or boolean
    if (val === 'true') features[row.feature_name] = true;
    else if (val === 'false') features[row.feature_name] = false;
    else if (!isNaN(val)) features[row.feature_name] = parseInt(val, 10);
    else features[row.feature_name] = val;
  }

  return features;
}

async function checkFeature(restaurantId, featureName) {
  try {
    const features = await getEffectiveFeatures(restaurantId);
    return features[featureName] === true || features[featureName] === 1;
  } catch (err) {
    console.error(`[FeatureEngine] Error checking feature "${featureName}":`, err.message);
    return false;
  }
}

async function checkLimit(restaurantId, limitName, currentCount) {
  try {
    const features = await getEffectiveFeatures(restaurantId);
    const limit = features[limitName];
    if (limit === undefined || limit === null) return { allowed: true, limit: -1, current: currentCount };
    if (limit === -1) return { allowed: true, limit: -1, current: currentCount };
    return { allowed: currentCount < limit, limit, current: currentCount };
  } catch (err) {
    console.error(`[FeatureEngine] Error checking limit "${limitName}":`, err.message);
    return { allowed: false, limit: 0, current: currentCount };
  }
}

module.exports = { getEffectiveFeatures, checkFeature, checkLimit };
