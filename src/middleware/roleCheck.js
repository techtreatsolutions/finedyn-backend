'use strict';

const { error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

function requireRole(...roles) {
  return function roleCheckMiddleware(req, res, next) {
    if (!req.user) return error(res, 'Unauthorized. Authentication required.', HTTP_STATUS.UNAUTHORIZED);
    if (!roles.includes(req.user.role)) {
      return error(res, `Access denied. Required role(s): ${roles.join(', ')}.`, HTTP_STATUS.FORBIDDEN);
    }
    return next();
  };
}

module.exports = { requireRole };
