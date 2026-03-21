'use strict';

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  CASHIER: 'cashier',
  WAITER: 'waiter',
  KITCHEN_STAFF: 'kitchen_staff',
});

const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  READY: 'ready',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
});

const PAYMENT_MODES = Object.freeze({
  CASH: 'cash',
  CARD: 'card',
  UPI: 'upi',
  ONLINE: 'online',
  MIXED: 'mixed',
});

const RESTAURANT_TYPES = Object.freeze({
  POSS: 'poss',
  QR: 'qr',
});

const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  TRIAL: 'trial',
});

const TICKET_PRIORITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const TICKET_STATUS = Object.freeze({
  OPEN: 'open',
  ORDERED: 'ordered',
  RESOLVED: 'resolved',
});

const EXPENSE_STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
});

const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
});

const TABLE_STATUS = Object.freeze({
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RESERVED: 'reserved',
  CLEANING: 'cleaning',
});

const ITEM_TYPE = Object.freeze({
  VEG: 'veg',
  NON_VEG: 'non_veg',
  EGG: 'egg',
});

const QR_ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

module.exports = {
  ROLES,
  ORDER_STATUS,
  PAYMENT_STATUS,
  PAYMENT_MODES,
  RESTAURANT_TYPES,
  SUBSCRIPTION_STATUS,
  TICKET_PRIORITY,
  TICKET_STATUS,
  EXPENSE_STATUS,
  HTTP_STATUS,
  TABLE_STATUS,
  ITEM_TYPE,
  QR_ORDER_STATUS,
};
