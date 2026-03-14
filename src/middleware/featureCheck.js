'use strict';

const { checkFeature } = require('../utils/featureEngine');
const { error } = require('../utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('../config/constants');

function requireFeature(featureName) {
  return async function featureCheckMiddleware(req, res, next) {
    try {
      if (!req.user) return error(res, 'Unauthorized.', HTTP_STATUS.UNAUTHORIZED);
      if (req.user.role === ROLES.SUPER_ADMIN) return next();
      if (!req.user.restaurantId) return error(res, 'No restaurant associated with this account.', HTTP_STATUS.FORBIDDEN);

      const isEnabled = await checkFeature(req.user.restaurantId, featureName);
      if (!isEnabled) {
        return error(
          res,
          `The feature "${featureName}" is not available on your current plan. Please upgrade to access this feature.`,
          HTTP_STATUS.FORBIDDEN,
          { feature: featureName, upgradeRequired: true }
        );
      }
      return next();
    } catch (err) {
      console.error(`[FeatureCheck] Error:`, err.message);
      return error(res, 'Feature check failed.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };
}

module.exports = { requireFeature };
