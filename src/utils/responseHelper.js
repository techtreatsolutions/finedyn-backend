'use strict';

function success(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
}

function error(res, message = 'An error occurred', statusCode = 500, errors = null) {
  const body = {
    success: false,
    message,
    timestamp: new Date().toISOString(),
  };
  if (errors !== null && errors !== undefined) {
    body.errors = errors;
  }
  return res.status(statusCode).json(body);
}

function paginate(res, data, total, page, limit, message = 'Data retrieved successfully') {
  const totalPages = Math.ceil(total / limit);
  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      totalPages,
      hasNextPage: parseInt(page, 10) < totalPages,
      hasPrevPage: parseInt(page, 10) > 1,
    },
    timestamp: new Date().toISOString(),
  });
}

module.exports = { success, error, paginate };
