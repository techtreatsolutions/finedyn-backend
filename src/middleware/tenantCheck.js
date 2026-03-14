'use strict';

const { error } = require('../utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('../config/constants');

function tenantCheck(req, res, next) {
  if (!req.user) return error(res, 'Unauthorized.', HTTP_STATUS.UNAUTHORIZED);
  if (req.user.role === ROLES.SUPER_ADMIN) return next();

  const targetRestaurantId = req.params.restaurantId || req.body.restaurantId || req.query.restaurantId || null;
  if (targetRestaurantId === null) return next();

  const targetId = parseInt(targetRestaurantId, 10);
  const userRestaurantId = parseInt(req.user.restaurantId, 10);

  if (isNaN(targetId) || isNaN(userRestaurantId) || targetId !== userRestaurantId) {
    return error(res, 'Access denied. You cannot access another restaurant\'s data.', HTTP_STATUS.FORBIDDEN);
  }
  return next();
}

module.exports = { tenantCheck };
